-- Campaign planners use a quarter of the pooled rate per shared workspace. Daily remaining quota
-- is account-wide; dispatcher gates still pace against the unmodified provider_account_limits row.
CREATE OR REPLACE VIEW provider_workspace_limits AS
SELECT c.workspace_id, l.aws_account_id, l.region, l.environment, l.refresh_after, l.checked_at,
       CASE WHEN c.kind = 'shared' THEN l.max_send_rate / 4 ELSE l.max_send_rate END AS max_send_rate,
       l.max_24_hour_send, l.sent_last_24_hours
FROM provider_connections c JOIN provider_account_limits l USING (aws_account_id, region)
WHERE c.status = 'ready';
