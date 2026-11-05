ALTER TABLE provider_connections ADD COLUMN resource_prefix text, ADD COLUMN confirmed_message_id text;
UPDATE provider_connections SET resource_prefix='opensend-'||left(encode(sha256(convert_to(id,'UTF8')),'hex'),20) WHERE kind='byo';
CREATE UNIQUE INDEX provider_connections_stack_prefix ON provider_connections(resource_prefix) WHERE resource_prefix IS NOT NULL;

-- Account-scoped SES sending authorization is not DNS ownership. Multiple workspaces may have the
-- same account-scoped name, but at most one can reserve it exclusively. A successful TXT upgrade
-- survives disconnect; an unproven import does not. All existing claims keep their original scope.
ALTER TABLE domain_claims DROP CONSTRAINT domain_claims_pkey,
  ADD COLUMN claim_scope text NOT NULL DEFAULT 'exclusive' CHECK (claim_scope IN ('account','exclusive','txt')),
  ADD PRIMARY KEY(workspace_id,name), ADD CONSTRAINT account_claim_sends_only CHECK (claim_scope<>'account' OR receiving_state='off');
CREATE UNIQUE INDEX domain_claims_exclusive_name ON domain_claims(name) WHERE claim_scope<>'account';
CREATE FUNCTION exclusive_domain_overlap(wid text,host text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM domain_claims dc WHERE dc.workspace_id<>wid AND dc.claim_scope<>'account' AND
    (right('.'||dc.name,length(host)+1)='.'||host OR right('.'||host,length(dc.name)+1)='.'||dc.name))
$$;
-- Called only after checking the exact token at _opensend.<host>. Acquire the same namespace lock
-- before checking exclusivity as an ordinary reservation, then fence against disconnect/reclaim.
CREATE FUNCTION promote_imported_claim(wid text,host text,proof uuid,connection text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  UPDATE domain_claims SET claim_scope='txt' WHERE workspace_id=wid AND name=host AND token=proof AND connection_id=connection
    AND claim_scope='account' AND NOT exclusive_domain_overlap(wid,host);
END $$;

-- A proven BYO account may reserve its verified domains during setup. Normal callers can only
-- reserve on a ready connection. Both paths serialize on exactly the same parent/child lock.
DROP FUNCTION reserve_domain_claim(text,text,text,text);
CREATE FUNCTION reserve_domain_claim(wid text, host text, requested_region text, new_id text, importing text DEFAULT NULL) RETURNS TABLE
  (connection jsonb, token uuid, id text, readiness jsonb, fresh boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.region=requested_region AND
      ((importing IS NULL AND c.state='ready') OR (c.id=importing AND c.kind='byo' AND c.state='provisioning')) FOR SHARE OF s,c;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection := to_jsonb(pc);
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=host FOR UPDATE;
  fresh := NOT FOUND;
  IF importing IS NULL AND coalesce(claim.claim_scope,'exclusive')<>'account' AND exclusive_domain_overlap(wid,host) THEN RETURN NEXT; RETURN; END IF;
  IF fresh THEN
    INSERT INTO domain_claims(name,workspace_id,connection_id,claim_scope) VALUES(host,wid,pc.id,CASE WHEN importing IS NULL THEN 'exclusive' ELSE 'account' END) RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id IS NULL THEN
    fresh := true;
    UPDATE domain_claims dc SET connection_id=pc.id,claim_scope=CASE WHEN importing IS NOT NULL AND dc.claim_scope<>'txt' THEN 'account' ELSE dc.claim_scope END
      WHERE dc.workspace_id=wid AND dc.name=host RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id=pc.id THEN
    SELECT d.id INTO id FROM operation_domains d WHERE d.workspace_id=wid AND d.name=host AND d.region=requested_region;
    token := claim.token; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token := claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,region) VALUES(new_id,host,wid,requested_region)
    ON CONFLICT ON CONSTRAINT operation_domain_scope DO UPDATE SET updated_at=now() RETURNING d.id INTO id;
  IF importing IS NULL THEN
    INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'domain.verify',
      jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
      ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  END IF;
  RETURN NEXT;
END $$;
