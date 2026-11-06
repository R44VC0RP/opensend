-- The dispatch owner lookup starts with a region, not a connection. A busy installation
-- can prebuild this small routing-table index CONCURRENTLY before running the migration.
SET LOCAL lock_timeout='1s';
CREATE INDEX IF NOT EXISTS provider_regions_ready_dispatch ON provider_connection_regions(region,connection_id) WHERE sending_state='ready';

-- Both dispatch views filter this expression (the fallback is used by simulation).
-- Without its distribution the planner estimates a large shared pool like a tiny BYO
-- account, choosing one random index probe per tenant even in a dense region.
CREATE STATISTICS IF NOT EXISTS provider_dispatch_account_frequency ON (coalesce(aws_account_id,'000000000000')) FROM provider_connections;
ANALYZE provider_connections;
