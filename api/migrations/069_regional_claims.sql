SET LOCAL lock_timeout='1s';
-- The five-argument function remains the contract for old workers. Share its namespace lock,
-- expiry, scope and capacity policy; only the selected connection/region differs.
CREATE FUNCTION reserve_regional_claim(wid text,host text,requested_region text,new_id text,importing text DEFAULT NULL,placed boolean DEFAULT false)
RETURNS TABLE(connection jsonb,token uuid,id text,readiness jsonb,fresh boolean,error_code text)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE pc provider_connections%ROWTYPE; r provider_connection_regions%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND (c.state='ready' OR (c.id=importing AND c.kind='byo' AND c.state='provisioning'))
    FOR NO KEY UPDATE OF s FOR SHARE OF c;
  IF NOT FOUND OR (importing IS NOT NULL AND (pc.kind<>'byo' OR pc.id<>importing)) THEN RETURN NEXT; RETURN; END IF;
  IF pc.kind='shared' AND NOT placed AND requested_region IS NOT NULL AND requested_region<>pc.region THEN
    connection:=to_jsonb(pc);error_code:='POOL_PLACEMENT_MANAGED';RETURN NEXT; RETURN;
  END IF;
  -- An idempotent request with no override selects its existing binding first (even when
  -- disabled, in which case fail closed rather than falling through to the default).
  requested_region:=coalesce(requested_region,(SELECT b.region FROM domain_sending_bindings b WHERE b.workspace_id=wid AND b.name=host),CASE WHEN pc.kind='shared' THEN pc.region END);
  SELECT cr.* INTO r FROM provider_connection_regions cr WHERE cr.connection_id=pc.id AND (requested_region IS NULL OR cr.region=requested_region)
    AND (cr.sending_state='ready' OR (importing=pc.id AND cr.sending_state='provisioning'))
    ORDER BY cr.region=pc.region DESC,cr.region LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection:=to_jsonb(pc)||jsonb_build_object('region',r.region,'legacy',r.legacy,'managed_tenant',r.managed_tenant,'tenant_state',r.tenant_state,'legacy_names',
    CASE WHEN pc.kind='byo' THEN r.legacy ELSE coalesce((SELECT p.legacy_names FROM provider_pool_regions p WHERE p.region=r.region),r.legacy) END);
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=host FOR UPDATE;
  fresh:=NOT FOUND;
  IF importing IS NULL AND coalesce(claim.claim_scope,'exclusive')<>'account' AND exclusive_domain_overlap(wid,host) THEN RETURN NEXT; RETURN; END IF;
  IF fresh THEN
    IF (SELECT count(*)>=100 OR (importing IS NULL AND count(*) FILTER(WHERE NOT dc.ever_proven)>=10) FROM domain_claims dc WHERE dc.workspace_id=wid) THEN
      error_code:='DOMAIN_LIMIT_REACHED'; RETURN NEXT; RETURN;
    END IF;
    INSERT INTO domain_claims(name,workspace_id,connection_id,claim_scope) VALUES(host,wid,pc.id,CASE WHEN importing IS NULL THEN 'exclusive' ELSE 'account' END) RETURNING * INTO claim;
  ELSIF importing IS NULL AND domain_claim_expired(claim) THEN error_code:='DOMAIN_CLAIM_EXPIRED'; RETURN NEXT; RETURN;
  ELSIF claim.connection_id IS NULL THEN
    fresh:=true;
    UPDATE domain_claims dc SET connection_id=pc.id,claim_scope=CASE WHEN importing IS NOT NULL AND dc.claim_scope<>'txt' THEN 'account' ELSE dc.claim_scope END
      WHERE dc.workspace_id=wid AND dc.name=host RETURNING * INTO claim;
  ELSIF claim.connection_id=pc.id THEN
    SELECT b.domain_id INTO id FROM domain_sending_bindings b WHERE b.workspace_id=wid AND b.name=host AND b.connection_id=pc.id AND b.region=r.region;
    IF NOT FOUND THEN error_code:='DOMAIN_REGION_CONFLICT'; END IF;
    token:=claim.token; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token:=claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,region) VALUES(new_id,host,wid,r.region) RETURNING d.id INTO id;
  IF importing IS NULL THEN
    INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'domain.verify',
      jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
      ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  END IF;
  RETURN NEXT;
END $$;

-- Rolling back admission stops new regional mail, not its dispatch fence. An old binary
-- must never authorize an unpinned send through the parent of a regionally placed claim.
CREATE OR REPLACE VIEW verified_sending_domains AS
  SELECT dc.workspace_id,pc.region,dc.name FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id
  WHERE pc.state='ready' AND dc.sending_state IN ('verified','lost') AND NOT pc.managed_tenant
    AND NOT EXISTS (SELECT FROM provider_connection_regions r WHERE r.connection_id=pc.id AND NOT r.legacy AND r.sending_state<>'unprovisioned') FOR SHARE OF dc,pc;

-- Keep migration 062's hourly accounting intact when an already-attempted envelope's
-- feedback topic is retired. No counter rebuild, event replay or scan of retained mail.
CREATE OR REPLACE VIEW hosted_real_envelopes AS SELECT e.id,e.workspace_id,e.created_at,e.status,e.provider_id,
  hosted_real_cost(e.to_addresses || e.cc_addresses || e.bcc_addresses) AS cost
  FROM sending_emails e LEFT JOIN provider_connections pc USING(workspace_id)
  WHERE NOT e.simulated AND ((e.feedback_topic_arn IS NULL AND pc.kind='shared') OR EXISTS
    (SELECT FROM provider_feedback_history h WHERE h.topic_arn=e.feedback_topic_arn AND h.kind='shared'));
