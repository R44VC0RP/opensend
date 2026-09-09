CREATE TABLE ses_installation_settings (
 workspace_id text PRIMARY KEY,
 installation_id text NOT NULL,
 default_region text NOT NULL,
 enabled_regions jsonb NOT NULL,
 CHECK (jsonb_typeof(enabled_regions) = 'array' AND jsonb_array_length(enabled_regions) BETWEEN 1 AND 40),
 CHECK (enabled_regions ? default_region)
);
CREATE TABLE ses_region_discovery (
 workspace_id text NOT NULL,
 region text NOT NULL,
 report jsonb,
 credentials_fingerprint text,
 public_url text,
 last_discovered_at timestamptz,
 trusted_account_id text,
 trusted_topic_arn text,
 trusted_credentials_fingerprint text,
 provision_job_id text,
 PRIMARY KEY (workspace_id, region)
);
