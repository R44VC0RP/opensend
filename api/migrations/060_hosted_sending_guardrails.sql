-- Hosted connections enter ready on creation. Older releases did not store that time;
-- use durable workspace age for already-ready Hosted tenants. Jobs expire after 30 days.
ALTER TABLE provider_connections ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN paused_at timestamptz, ADD COLUMN pause_reason text, ADD COLUMN resumed_at timestamptz,
  ADD CHECK ((paused_at IS NULL) = (pause_reason IS NULL) AND (kind='shared' OR paused_at IS NULL));
UPDATE provider_connections c SET created_at=w.created_at FROM workspaces w
WHERE c.kind='shared' AND c.tenant_state='ready' AND w.id=c.workspace_id;

-- Private feedback bookkeeping, separate from event data returned by the API and webhooks.
-- NULL means SES did not identify a recipient (including pre-migration events).
ALTER TABLE sending_email_events ADD COLUMN recipient_hashes text[];
CREATE INDEX sending_events_hosted_feedback ON sending_email_events(created_at,workspace_id,email_id)
  WHERE type IN ('bounce','complaint') AND NOT simulated;

-- Append to both views, keeping every existing column and all receive/setup behavior.
CREATE OR REPLACE VIEW provider_sending_connections AS
SELECT c.id,c.workspace_id,c.kind,c.region,c.aws_account_id,c.role_arn,c.external_id,
       coalesce(c.feedback_topic_arn,p.feedback_topic_arn) AS feedback_topic_arn,c.tenant_state,c.paused_at,c.pause_reason
FROM provider_connections c LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=c.region AND p.aws_account_id=c.aws_account_id AND p.sending_state='ready'
WHERE c.state='ready' AND coalesce(c.feedback_topic_arn,p.feedback_topic_arn) IS NOT NULL;
CREATE OR REPLACE VIEW provider_simulated_connections AS
SELECT id,workspace_id,kind,region,coalesce(aws_account_id,'000000000000') AS aws_account_id,
       role_arn,external_id,feedback_topic_arn,tenant_state,paused_at,pause_reason
FROM provider_connections WHERE state='ready';
