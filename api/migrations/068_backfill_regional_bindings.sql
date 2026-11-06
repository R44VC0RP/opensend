SET LOCAL lock_timeout='1s';
-- The singleton trigger is already live. Lock the source before copying so a just-committed
-- verify/disconnect cannot be overwritten by the migration snapshot.
DO $$ BEGIN
IF NOT EXISTS(SELECT FROM provider_connections) THEN RETURN; END IF; -- No domain/mailbox scan on self-hosted installations.
PERFORM mirror_legacy_connection(row) FROM (SELECT c AS row FROM provider_connections c ORDER BY id FOR SHARE) locked;
UPDATE provider_connection_regions r SET inbound_topic_arn=m.topic_arn,receiving_state=CASE WHEN m.last_reconciled_at IS NULL THEN 'provisioning' ELSE 'active' END
  FROM provider_connections c JOIN mailbox_regions m ON m.workspace_id=c.workspace_id AND m.account_id=c.aws_account_id AND m.region=c.region
  WHERE r.legacy AND c.kind='byo' AND r.connection_id=c.id AND r.region=c.region AND m.topic_arn IS NOT NULL;
INSERT INTO domain_sending_bindings SELECT dc.workspace_id,dc.name,d.id,c.id,d.region FROM domain_claims dc
  JOIN provider_connections c ON c.id=dc.connection_id AND c.workspace_id=dc.workspace_id
  JOIN operation_domains d ON d.workspace_id=dc.workspace_id AND d.name=dc.name AND d.region=c.region
  FOR SHARE OF c,dc,d ON CONFLICT DO NOTHING;
END $$;
UPDATE provider_pool_regions SET pool_tier=CASE region WHEN 'us-east-1' THEN 'trusted' ELSE 'probation' END WHERE pool_tier IS NULL;
INSERT INTO provider_feedback_history SELECT feedback_topic_arn,region,aws_account_id,'shared' FROM provider_pool_regions
  WHERE sending_state='ready' AND feedback_topic_arn LIKE 'arn:aws:sns:'||region||':'||aws_account_id||':%' ON CONFLICT DO NOTHING;
