-- Expand first: 2f350fa still names the columns and uses the old ON CONFLICT targets.
-- Existing writes specify 'live'; new writes omit it. Never promote test credentials or queued mail.
-- Child tables first (including both attachment FKs and the non-cascading thread/domain FKs).
DO $$
DECLARE t text; kept bigint; live_children jsonb := '{}';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'mail_attachments', 'mail_message_ids', 'mail_unrouted',
    'mailbox_messages', 'mailbox_threads', 'mailbox_addresses',
    'mailbox_webhook_deliveries', 'mail_messages', 'mailboxes',
    'mail_threads', 'mailbox_domains', 'mailbox_webhooks',
    'sending_attachment_links', 'sending_campaign_expansions', 'sending_campaign_reviews',
    'sending_email_events', 'operation_delivery_attempts', 'operation_deliveries',
    'audience_list_members', 'audience_consent_audit', 'agent_tokens',
    'api_keys', 'audience_contacts', 'audience_imports',
    'audience_lists', 'audience_operation_plans', 'audience_segments',
    'jobs', 'mail_receipts', 'mailbox_events',
    'mailbox_keys', 'operation_domains', 'operation_events',
    'operation_settings', 'operation_sns_receipts', 'operation_unsubscribe_tokens',
    'operation_webhooks', 'provider_account_limits', 'sending_attachments',
    'sending_campaigns', 'sending_emails', 'sending_idempotency',
    'sending_region_limits'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN environment SET DEFAULT %L', t, 'live');
    EXECUTE format('DELETE FROM %I WHERE environment = %L', t, 'test');
    EXECUTE format('ALTER TABLE %I ADD CHECK (environment = %L)', t, 'live');
    -- These seven leaves also have ON DELETE CASCADE FKs. Their locks last to commit.
    -- If historically inconsistent data would cascade a live child, roll back, don't lose it.
    IF t IN ('mail_attachments', 'mail_message_ids', 'mail_unrouted', 'mailbox_messages',
             'mailbox_threads', 'mailbox_addresses', 'mailbox_webhook_deliveries') THEN
      EXECUTE format('SELECT count(*) FROM %I', t) INTO kept;
      live_children := live_children || jsonb_build_object(t, kept);
    END IF;
  END LOOP;
  FOR t IN SELECT jsonb_object_keys(live_children) LOOP
    EXECUTE format('SELECT count(*) FROM %I', t) INTO kept;
    IF kept <> (live_children->>t)::bigint THEN
      RAISE EXCEPTION 'Live rows in % reference test data; resolve the mixed references before upgrading.', t;
    END IF;
  END LOOP;
END $$;

-- V2 references are single-mode grants. For older references, both the original ceiling
-- and the effective consent/client/resource policies had to permit live access.
DELETE FROM oauth_consent c WHERE c.reference_id ~ '^mcp_[0-9a-f-]{36}\|'
  AND (NOT ('opensend:live' = ANY(string_to_array(split_part(c.reference_id, '|', 2), ' ')))
    OR NOT ('opensend:live' = ANY(c.scopes))
    OR EXISTS (SELECT 1 FROM oauth_client k WHERE k.client_id = c.client_id AND NOT ('opensend:live' = ANY(k.scopes)))
    OR EXISTS (SELECT 1 FROM oauth_resource r WHERE r.identifier = ANY(c.resources) AND NOT ('opensend:live' = ANY(r.allowed_scopes))));

-- Keep one unique arbiter per key during the rollout: two overlapping indexes can race
-- and produce 23505 on the index not targeted by ON CONFLICT. The old Worker infers
-- the original columns; the new one targets the same constraint by name. These three
-- standalone indexes need attaching to constraints; affected primary keys already have names.
ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_email_scope UNIQUE USING INDEX audience_contacts_email_scope;
ALTER TABLE mailbox_domains ADD CONSTRAINT mailbox_domains_name UNIQUE USING INDEX mailbox_domains_name;
ALTER TABLE operation_domains ADD CONSTRAINT operation_domain_scope UNIQUE USING INDEX operation_domain_scope;

-- Non-unique read indexes do not arbitrate inserts and can already use the final layout.
DROP INDEX audience_consent_page;
CREATE INDEX audience_consent_page ON audience_consent_audit (workspace_id, contact_id, id);
DROP INDEX audience_contacts_page;
CREATE INDEX audience_contacts_page ON audience_contacts (workspace_id, id);
DROP INDEX audience_imports_page;
CREATE INDEX audience_imports_page ON audience_imports (workspace_id, id);
DROP INDEX audience_members_contact;
CREATE INDEX audience_members_contact ON audience_list_members (workspace_id, contact_id);
DROP INDEX audience_lists_page;
CREATE INDEX audience_lists_page ON audience_lists (workspace_id, id);
DROP INDEX audience_plans_scope;
CREATE INDEX audience_plans_scope ON audience_operation_plans (workspace_id, id);
DROP INDEX audience_segments_page;
CREATE INDEX audience_segments_page ON audience_segments (workspace_id, id);
DROP INDEX jobs_workspace_due_idx;
CREATE INDEX jobs_workspace_due_idx ON jobs (workspace_id, status, available_at);
DROP INDEX mail_messages_tenant_page;
CREATE INDEX mail_messages_tenant_page ON mail_messages (workspace_id, direction, received_at DESC, id DESC);
DROP INDEX mailbox_events_mailbox;
CREATE INDEX mailbox_events_mailbox ON mailbox_events (workspace_id, mailbox_id, seq);
DROP INDEX mailbox_messages_tenant_thread_page;
CREATE INDEX mailbox_messages_tenant_thread_page ON mailbox_messages (workspace_id, thread_id, received_at DESC, message_id DESC);
DROP INDEX mailbox_webhooks_page;
CREATE INDEX mailbox_webhooks_page ON mailbox_webhooks (workspace_id, id);
DROP INDEX mailboxes_domain;
CREATE INDEX mailboxes_domain ON mailboxes (workspace_id, domain_id);
DROP INDEX mailboxes_page;
CREATE INDEX mailboxes_page ON mailboxes (workspace_id, id);
DROP INDEX operation_delivery_scope;
CREATE INDEX operation_delivery_scope ON operation_deliveries (workspace_id, webhook_id, id);
DROP INDEX operation_attempt_delivery;
CREATE INDEX operation_attempt_delivery ON operation_delivery_attempts (workspace_id, delivery_id);
DROP INDEX operation_events_email_metrics;
CREATE INDEX operation_events_email_metrics ON operation_events (workspace_id, created_at) WHERE (data ? 'emailId');
DROP INDEX operation_events_metrics;
CREATE INDEX operation_events_metrics ON operation_events (workspace_id, created_at);
DROP INDEX operation_webhook_scope;
CREATE INDEX operation_webhook_scope ON operation_webhooks (workspace_id, id);
DROP INDEX sending_attachment_owner;
CREATE INDEX sending_attachment_owner ON sending_attachment_links (workspace_id, owner_type, owner_id);
DROP INDEX sending_attachments_page;
CREATE INDEX sending_attachments_page ON sending_attachments (workspace_id, id);
DROP INDEX sending_expansion_scope;
CREATE INDEX sending_expansion_scope ON sending_campaign_expansions (workspace_id, actor_key_id);
DROP INDEX sending_review_campaign;
CREATE INDEX sending_review_campaign ON sending_campaign_reviews (workspace_id, campaign_id);
DROP INDEX sending_reviews_preparing;
CREATE INDEX sending_reviews_preparing ON sending_campaign_reviews (workspace_id, actor_key_id) WHERE (status IN ('pending', 'processing'));
DROP INDEX sending_campaigns_archive_page;
CREATE INDEX sending_campaigns_archive_page ON sending_campaigns (workspace_id, archived_at, created_at DESC, id DESC);
DROP INDEX sending_campaigns_created_page;
CREATE INDEX sending_campaigns_created_page ON sending_campaigns (workspace_id, created_at DESC, id DESC);
DROP INDEX sending_campaigns_page;
CREATE INDEX sending_campaigns_page ON sending_campaigns (workspace_id, id);
DROP INDEX sending_events_page;
CREATE INDEX sending_events_page ON sending_email_events (workspace_id, email_id, id);
DROP INDEX sending_emails_attempting;
CREATE INDEX sending_emails_attempting ON sending_emails (workspace_id, attempt_started_at) WHERE (status = 'attempting');
DROP INDEX sending_emails_campaign_pending;
CREATE INDEX sending_emails_campaign_pending ON sending_emails (workspace_id, campaign_id) WHERE (status IN ('queued', 'attempting'));
DROP INDEX sending_emails_campaign_status;
CREATE INDEX sending_emails_campaign_status ON sending_emails (workspace_id, campaign_id, status);
DROP INDEX sending_emails_created_page;
CREATE INDEX sending_emails_created_page ON sending_emails (workspace_id, created_at DESC, id DESC);
DROP INDEX sending_emails_direct_pending;
CREATE INDEX sending_emails_direct_pending ON sending_emails (workspace_id, actor_key_id) WHERE ((status IN ('queued', 'attempting')) AND (review_id IS NULL));
DROP INDEX sending_emails_dispatch_due;
CREATE INDEX sending_emails_dispatch_due ON sending_emails (workspace_id, region, ((campaign_id IS NULL)), created_at, id) WHERE (status = 'queued');
DROP INDEX sending_emails_feedback_provider;
CREATE INDEX sending_emails_feedback_provider ON sending_emails (region, provider_id) WHERE (provider_id IS NOT NULL);
DROP INDEX sending_emails_kind_created;
CREATE INDEX sending_emails_kind_created ON sending_emails (workspace_id, ((snapshot ->> 'kind')), created_at);
DROP INDEX sending_emails_page;
CREATE INDEX sending_emails_page ON sending_emails (workspace_id, id);
DROP INDEX sending_emails_region_owner_due;
CREATE INDEX sending_emails_region_owner_due ON sending_emails (region, workspace_id, ((campaign_id IS NULL)) DESC, created_at, id) WHERE (status = 'queued');

-- Simulation is a deployment setting, not a separate pool. Keep the old view name for 2f350fa.
CREATE VIEW provider_simulated_connections AS
SELECT id, workspace_id, kind, region, coalesce(aws_account_id, '000000000000') AS aws_account_id,
       role_arn, external_id, feedback_topic_arn, tenant_provisioned
FROM provider_connections WHERE status = 'ready';
CREATE OR REPLACE VIEW provider_test_connections AS SELECT * FROM provider_simulated_connections;

-- Keep the compatibility projection without depending on the underlying column.
CREATE OR REPLACE VIEW provider_workspace_limits AS
SELECT c.workspace_id, l.aws_account_id, l.region, 'live'::text AS environment, l.refresh_after, l.checked_at,
       CASE WHEN c.kind = 'shared' THEN l.max_send_rate / 4 ELSE l.max_send_rate END AS max_send_rate,
       l.max_24_hour_send, l.sent_last_24_hours
FROM provider_connections c JOIN provider_account_limits l USING (aws_account_id, region)
WHERE c.status = 'ready';

CREATE OR REPLACE FUNCTION record_email_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Rows are locked in id order, as every other multi-email writer does, so this cannot add a deadlock.
  WITH bits AS (
    SELECT n.workspace_id, n.data->>'emailId' AS email_id,
      bit_or(CASE n.type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3
        WHEN 'email.bounced' THEN CASE WHEN n.data->>'bounceSubType' = 'EmailValidationSuppressed' THEN 0 ELSE 5 END
        WHEN 'email.complained' THEN 9 WHEN 'email.delivery_delayed' THEN 129 WHEN 'email.opened' THEN 16
        WHEN 'email.clicked' THEN 32 WHEN 'email.rejected' THEN 64 WHEN 'email.rendering_failed' THEN 64 ELSE 0 END) AS bits
    FROM new_events n WHERE n.data ? 'emailId' GROUP BY 1, 2
  ), targets AS (
    SELECT e.id, b.bits::smallint AS bits FROM sending_emails e
    JOIN bits b ON e.id = b.email_id AND e.workspace_id = b.workspace_id
    WHERE b.bits <> 0 AND (e.event_outcomes | b.bits::smallint) <> e.event_outcomes
    ORDER BY e.id FOR UPDATE OF e
  )
  UPDATE sending_emails e SET event_outcomes = e.event_outcomes | t.bits FROM targets t WHERE e.id = t.id;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION reserve_domain_claim(wid text, host text, requested_region text, new_id text) RETURNS TABLE
  (connection jsonb, token uuid, id text, readiness jsonb, fresh boolean)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.region=requested_region AND c.status='ready' FOR SHARE OF s,c;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection := to_jsonb(pc);
  IF EXISTS (SELECT 1 FROM domain_claims dc WHERE dc.workspace_id<>wid AND (
    right('.'||dc.name,length(host)+1)='.'||host OR right('.'||host,length(dc.name)+1)='.'||dc.name)) THEN RETURN NEXT; RETURN; END IF;
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.name=host FOR UPDATE;
  fresh := NOT FOUND;
  IF fresh THEN
    INSERT INTO domain_claims(name,workspace_id,connection_id) VALUES(host,wid,pc.id) RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id IS NULL THEN
    -- A pre-upgrade disconnect retained this claim. Verify its original tag; never adopt an untagged identity.
    fresh := true;
    UPDATE domain_claims dc SET connection_id=pc.id,verified=false,ready=false,readiness=NULL WHERE dc.name=host RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id=pc.id THEN
    SELECT d.id INTO id FROM operation_domains d WHERE d.workspace_id=wid AND d.name=host AND d.region=requested_region;
    token := claim.token; readiness := claim.readiness; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token := claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,region) VALUES(new_id,host,wid,requested_region)
    ON CONFLICT ON CONSTRAINT operation_domain_scope DO UPDATE SET updated_at=now() RETURNING d.id INTO id;
  INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'domain.verify',
    jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
    ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  RETURN NEXT;
END $$;
