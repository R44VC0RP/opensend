-- Give existing claims a full proof window. The last DNS/SES observation is not a history:
-- once ownership was observed, a later loss of proof (or disconnect) must not start expiry.
ALTER TABLE domain_claims ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN ever_proven boolean NOT NULL DEFAULT false;
UPDATE domain_claims dc SET ever_proven=true WHERE claim_scope IN ('txt','account') OR identity @> '{"proven":true}'
  OR sending_state IN ('verified','lost') OR receiving_state<>'off'
  OR (identity->'ses'->>'VerificationStatus'='SUCCESS' AND EXISTS (SELECT 1 FROM provider_connections pc WHERE pc.id=dc.connection_id AND pc.kind='byo'));
CREATE INDEX domain_claims_unproven_age ON domain_claims(created_at,token) WHERE NOT ever_proven;
-- Also remember observations from workers running the previous release during rollout.
CREATE FUNCTION remember_domain_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.identity @> '{"proven":true}' OR NEW.claim_scope='txt' THEN NEW.ever_proven := true; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER remember_domain_proof BEFORE INSERT OR UPDATE OF identity,claim_scope ON domain_claims
  FOR EACH ROW EXECUTE FUNCTION remember_domain_proof();

CREATE FUNCTION domain_claim_expired(dc domain_claims) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT dc.ever_proven AND dc.created_at <= now() - interval '72 hours'
$$;

DROP FUNCTION reserve_domain_claim(text,text,text,text,text);
CREATE FUNCTION reserve_domain_claim(wid text, host text, requested_region text, new_id text, importing text DEFAULT NULL) RETURNS TABLE
  (connection jsonb, token uuid, id text, readiness jsonb, fresh boolean, error_code text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  -- Serialize the workspace count + insert, including concurrent reservations on unrelated names.
  -- Settings first, as in disconnect/import; only then take the cross-workspace overlap lock.
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.region=requested_region AND
      ((importing IS NULL AND c.state='ready') OR (c.id=importing AND c.kind='byo' AND c.state='provisioning')) FOR NO KEY UPDATE OF s FOR SHARE OF c;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection := to_jsonb(pc);
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=host FOR UPDATE;
  fresh := NOT FOUND;
  IF importing IS NULL AND coalesce(claim.claim_scope,'exclusive')<>'account' AND exclusive_domain_overlap(wid,host) THEN RETURN NEXT; RETURN; END IF;
  IF fresh THEN
    IF (SELECT count(*)>=100 OR (importing IS NULL AND count(*) FILTER (WHERE NOT dc.ever_proven)>=10) FROM domain_claims dc WHERE dc.workspace_id=wid) THEN
      error_code := 'DOMAIN_LIMIT_REACHED'; RETURN NEXT; RETURN;
    END IF;
    INSERT INTO domain_claims(name,workspace_id,connection_id,claim_scope) VALUES(host,wid,pc.id,CASE WHEN importing IS NULL THEN 'exclusive' ELSE 'account' END) RETURNING * INTO claim;
  ELSIF importing IS NULL AND domain_claim_expired(claim) THEN
    error_code := 'DOMAIN_CLAIM_EXPIRED'; RETURN NEXT; RETURN;
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
