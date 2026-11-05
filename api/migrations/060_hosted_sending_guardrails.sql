-- Hosted connections enter ready on creation. Older releases did not store that time;
-- recover it from the provisioning job when present, otherwise start the ramp now.
ALTER TABLE provider_connections ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN paused_at timestamptz, ADD COLUMN pause_reason text,
  ADD CHECK ((paused_at IS NULL) = (pause_reason IS NULL) AND (kind='shared' OR paused_at IS NULL));
UPDATE provider_connections c SET created_at=j.created_at FROM jobs j
WHERE c.kind='shared' AND j.workspace_id=c.workspace_id AND j.id='tenant.provision:'||c.id;

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
