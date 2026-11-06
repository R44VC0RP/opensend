SET LOCAL lock_timeout='1s';
-- Credential consumers need the actual stack version, not a resource naming convention.
-- Append columns so existing regional readers and the regional_sender function keep working.
CREATE OR REPLACE VIEW regional_connections AS
SELECT c.id,c.workspace_id,c.kind,r.region,c.aws_account_id,c.role_arn,c.external_id,
  CASE c.kind WHEN 'shared' THEN p.feedback_topic_arn ELSE r.feedback_topic_arn END AS feedback_topic_arn,r.tenant_state,c.paused_at,c.pause_reason,r.generation,
  CASE c.kind WHEN 'shared' THEN coalesce(p.legacy_names,r.legacy) ELSE r.legacy END AS legacy_names,p.pool_tier,p.sending_state AS pool_state,
  r.managed_tenant,r.legacy,r.sending_state,r.receiving_state,c.state,c.template_version
FROM provider_connection_regions r JOIN provider_connections c ON c.id=r.connection_id
LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=r.region AND p.aws_account_id=c.aws_account_id;
CREATE OR REPLACE VIEW regional_simulated_connections AS SELECT id,workspace_id,kind,region,coalesce(aws_account_id,'000000000000') AS aws_account_id,
  role_arn,external_id,feedback_topic_arn,tenant_state,paused_at,pause_reason,generation,legacy_names,pool_tier,pool_state,managed_tenant,template_version
  FROM regional_connections WHERE state='ready' AND sending_state='ready';
CREATE OR REPLACE VIEW regional_sending_connections AS SELECT * FROM regional_simulated_connections
  WHERE feedback_topic_arn LIKE 'arn:aws:sns:'||region||':'||aws_account_id||':%' AND (kind='byo' OR pool_state='ready');
