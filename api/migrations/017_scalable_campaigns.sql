-- Legacy reviews and queued mail remain readable and dispatchable without backfilling private content.
ALTER TABLE job_schedule DROP CONSTRAINT job_schedule_turn_check;
ALTER TABLE job_schedule ADD CONSTRAINT job_schedule_turn_check CHECK (turn BETWEEN 0 AND 15);
ALTER TABLE sending_campaigns ADD COLUMN preparing_review_id text;
ALTER TABLE sending_campaign_reviews
  ADD COLUMN storage_version integer NOT NULL DEFAULT 1 CHECK (storage_version IN (1,2)),
  ADD COLUMN status text NOT NULL DEFAULT 'ready' CHECK (status IN ('pending','processing','ready','failed')),
  ADD COLUMN actor_key_id text,
  ADD COLUMN processed integer NOT NULL DEFAULT 0 CHECK (processed >= 0),
  ADD COLUMN recipient_bytes bigint NOT NULL DEFAULT 0 CHECK (recipient_bytes >= 0),
  ADD COLUMN prepared_bytes bigint NOT NULL DEFAULT 0 CHECK (prepared_bytes >= 0),
  ADD COLUMN rendered jsonb,
  ADD COLUMN error jsonb;
CREATE TABLE sending_review_recipients (
  review_id text NOT NULL REFERENCES sending_campaign_reviews(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0), recipient jsonb NOT NULL,
  recipient_bytes integer NOT NULL CHECK (recipient_bytes > 0),
  content_hash text, subject text, snapshot_bytes integer CHECK (snapshot_bytes > 0),
  PRIMARY KEY (review_id, ordinal)
);
CREATE TABLE sending_campaign_expansions (
  campaign_id text PRIMARY KEY, review_id text NOT NULL UNIQUE,
  workspace_id text NOT NULL, environment text NOT NULL CHECK (environment IN ('live','test')),
  actor_key_id text NOT NULL, total integer NOT NULL CHECK (total > 0 AND total <= 1000000),
  expanded integer NOT NULL DEFAULT 0 CHECK (expanded >= 0 AND expanded <= total),
  canceled integer NOT NULL DEFAULT 0 CHECK (canceled >= 0 AND canceled <= total),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','expanding','completed','failed','canceled')),
  error jsonb, request_id text, job_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sending_expansion_scope ON sending_campaign_expansions(workspace_id, environment, actor_key_id);
ALTER TABLE sending_emails ADD COLUMN review_id text, ADD COLUMN review_ordinal integer;
ALTER TABLE sending_emails ADD CONSTRAINT sending_emails_review_pair CHECK ((review_id IS NULL) = (review_ordinal IS NULL));
CREATE UNIQUE INDEX sending_emails_review_recipient ON sending_emails(review_id, review_ordinal);
CREATE INDEX sending_emails_campaign_pending ON sending_emails(workspace_id, environment, campaign_id) WHERE status IN ('queued','attempting');
CREATE INDEX sending_emails_direct_pending ON sending_emails(workspace_id, environment, actor_key_id) WHERE status IN ('queued','attempting') AND review_id IS NULL;
CREATE INDEX sending_reviews_preparing ON sending_campaign_reviews(workspace_id, environment, actor_key_id) WHERE status IN ('pending','processing');
-- Durable cursor retries may fill a row exactly once, never revise a captured recipient or prepared message.
CREATE FUNCTION protect_review_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.recipient IS DISTINCT FROM OLD.recipient OR NEW.recipient_bytes IS DISTINCT FROM OLD.recipient_bytes
     OR (OLD.content_hash IS NOT NULL AND (NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.subject IS DISTINCT FROM OLD.subject OR NEW.snapshot_bytes IS DISTINCT FROM OLD.snapshot_bytes)) THEN
    RAISE EXCEPTION 'review recipient snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sending_review_recipient_immutable BEFORE UPDATE ON sending_review_recipients FOR EACH ROW EXECUTE FUNCTION protect_review_recipient();
