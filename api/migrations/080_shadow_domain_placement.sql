SET LOCAL lock_timeout='1s';
-- Private observations, never a routing binding. A new claim has a new domain id.
CREATE TABLE domain_placement_shadow (
  domain_id text PRIMARY KEY REFERENCES operation_domains(id) ON DELETE CASCADE,
  policy_version integer NOT NULL,
  started_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  score integer NOT NULL,
  decision text NOT NULL CHECK (decision IN ('hold','virginia','ohio')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons)='array'),
  signals jsonb NOT NULL CHECK (jsonb_typeof(signals)='object')
);
CREATE INDEX domain_placement_shadow_recent ON domain_placement_shadow(recorded_at DESC);
