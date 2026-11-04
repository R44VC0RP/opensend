-- An MX connection is sendable only after its account, stream resources and feedback topic are registered.
CREATE VIEW provider_sending_connections AS
SELECT c.id, c.workspace_id, c.kind, c.region, c.aws_account_id, c.role_arn, c.external_id,
       coalesce(c.feedback_topic_arn, p.feedback_topic_arn) AS feedback_topic_arn
FROM provider_connections c LEFT JOIN provider_pool_regions p ON c.kind='shared' AND p.region=c.region AND p.aws_account_id=c.aws_account_id AND p.ready
WHERE c.status='ready' AND coalesce(c.feedback_topic_arn, p.feedback_topic_arn) IS NOT NULL;
CREATE INDEX provider_connections_dispatch ON provider_connections(aws_account_id, region, workspace_id) WHERE status='ready';

-- Persist the topic at the attempt boundary: a BYO reconnection cannot claim an earlier account's feedback.
ALTER TABLE sending_emails ADD COLUMN feedback_topic_arn text;

CREATE TABLE provider_account_limits (
  aws_account_id text NOT NULL, region text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')),
  refresh_after timestamptz NOT NULL, checked_at timestamptz, max_send_rate double precision,
  max_24_hour_send double precision, sent_last_24_hours double precision, PRIMARY KEY (aws_account_id,region,environment)
);
CREATE VIEW provider_workspace_limits AS
SELECT c.workspace_id, l.* FROM provider_connections c JOIN provider_account_limits l USING (aws_account_id, region) WHERE c.status='ready';
