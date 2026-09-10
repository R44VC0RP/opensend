CREATE TABLE campaign_runs (
  id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES sending_campaigns(id) ON DELETE CASCADE, workspace_id text NOT NULL, environment text NOT NULL,
  revision integer NOT NULL, draft jsonb NOT NULL, content jsonb, actor jsonb NOT NULL,
  status text NOT NULL DEFAULT 'preparing', frozen boolean NOT NULL DEFAULT false,
  matched integer NOT NULL DEFAULT 0, eligible integer NOT NULL DEFAULT 0, suppressed integer NOT NULL DEFAULT 0, unsubscribed integer NOT NULL DEFAULT 0,
  prepared integer NOT NULL DEFAULT 0, expanded integer NOT NULL DEFAULT 0, cursor text NOT NULL DEFAULT '',
  error_code text, scheduled_at timestamptz, content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX campaign_runs_active_revision ON campaign_runs(campaign_id, revision) WHERE status NOT IN ('failed','canceled');
CREATE INDEX campaign_runs_scope ON campaign_runs(workspace_id, environment, campaign_id, created_at DESC);
CREATE TABLE campaign_recipients (
  run_id text NOT NULL REFERENCES campaign_runs(id) ON DELETE CASCADE, contact_id text NOT NULL,
  email text NOT NULL, name text, properties jsonb NOT NULL, eligible boolean NOT NULL, exclusion text,
  email_id text, PRIMARY KEY(run_id, contact_id), UNIQUE(run_id, email)
);
CREATE INDEX campaign_recipients_expansion ON campaign_recipients(run_id, contact_id) WHERE eligible AND email_id IS NULL;
CREATE TABLE campaign_statistics (
  campaign_id text PRIMARY KEY, statuses jsonb NOT NULL DEFAULT '{}', outcomes jsonb NOT NULL DEFAULT '{}',
  total integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE campaign_email_outcomes (
  email_id text NOT NULL, campaign_id text NOT NULL, outcome text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(email_id, outcome)
);
CREATE INDEX campaign_outcomes_time ON campaign_email_outcomes(campaign_id, occurred_at);
CREATE TABLE campaign_daily_statistics (
  campaign_id text NOT NULL, day date NOT NULL, outcome text NOT NULL, count integer NOT NULL DEFAULT 0,
  PRIMARY KEY(campaign_id, day, outcome)
);
CREATE FUNCTION update_campaign_status_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.campaign_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN RETURN NEW; END IF;
  INSERT INTO campaign_statistics(campaign_id) VALUES(NEW.campaign_id) ON CONFLICT DO NOTHING;
  IF TG_OP = 'INSERT' THEN
    UPDATE campaign_statistics SET total = total + 1, statuses = jsonb_set(statuses, ARRAY[NEW.status], to_jsonb(coalesce((statuses->>NEW.status)::int,0)+1)), updated_at = now() WHERE campaign_id = NEW.campaign_id;
  ELSE
    UPDATE campaign_statistics SET statuses = jsonb_set(jsonb_set(statuses, ARRAY[OLD.status], to_jsonb(greatest(0,coalesce((statuses->>OLD.status)::int,0)-1))), ARRAY[NEW.status], to_jsonb(coalesce((statuses->>NEW.status)::int,0)+1)), updated_at = now() WHERE campaign_id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_status_statistics AFTER INSERT OR UPDATE OF status ON sending_emails FOR EACH ROW EXECUTE FUNCTION update_campaign_status_statistics();
CREATE FUNCTION update_campaign_event_statistics() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE campaign text; outcome_name text; inserted integer;
BEGIN
  SELECT campaign_id INTO campaign FROM sending_emails WHERE id = NEW.email_id AND workspace_id = NEW.workspace_id AND environment = NEW.environment AND NOT simulated;
  IF campaign IS NULL THEN RETURN NEW; END IF;
  outcome_name := CASE NEW.type WHEN 'send' THEN 'accepted' WHEN 'accepted' THEN 'accepted' WHEN 'delivery' THEN 'delivered' WHEN 'bounce' THEN 'bounced' WHEN 'complaint' THEN 'complained' WHEN 'open' THEN 'opened' WHEN 'click' THEN 'clicked' WHEN 'unsubscribe' THEN 'unsubscribed' ELSE NULL END;
  IF outcome_name IS NULL THEN RETURN NEW; END IF;
  INSERT INTO campaign_email_outcomes(email_id,campaign_id,outcome,occurred_at) VALUES(NEW.email_id,campaign,outcome_name,NEW.created_at) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 1 THEN
    INSERT INTO campaign_statistics(campaign_id) VALUES(campaign) ON CONFLICT DO NOTHING;
    UPDATE campaign_statistics SET outcomes = jsonb_set(outcomes, ARRAY[outcome_name], to_jsonb(coalesce((outcomes->>outcome_name)::int,0)+1)), updated_at = now() WHERE campaign_id = campaign;
    INSERT INTO campaign_daily_statistics(campaign_id,day,outcome,count) VALUES(campaign,(NEW.created_at AT TIME ZONE 'UTC')::date,outcome_name,1) ON CONFLICT(campaign_id,day,outcome) DO UPDATE SET count = campaign_daily_statistics.count + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_event_statistics AFTER INSERT ON sending_email_events FOR EACH ROW EXECUTE FUNCTION update_campaign_event_statistics();
-- Backfill retained history; subsequent retention does not decrement aggregates.
INSERT INTO campaign_statistics(campaign_id,total,statuses)
SELECT campaign_id,sum(n)::int,jsonb_object_agg(status,n) FROM (SELECT campaign_id,status,count(*)::int n FROM sending_emails WHERE campaign_id IS NOT NULL GROUP BY campaign_id,status) s GROUP BY campaign_id;
INSERT INTO campaign_email_outcomes(email_id,campaign_id,outcome,occurred_at)
SELECT e.id,e.campaign_id,CASE v.type WHEN 'send' THEN 'accepted' WHEN 'accepted' THEN 'accepted' WHEN 'delivery' THEN 'delivered' WHEN 'bounce' THEN 'bounced' WHEN 'complaint' THEN 'complained' WHEN 'open' THEN 'opened' WHEN 'click' THEN 'clicked' END,min(v.created_at)
FROM sending_emails e JOIN sending_email_events v ON v.email_id=e.id WHERE e.campaign_id IS NOT NULL AND NOT e.simulated AND v.type IN ('send','accepted','delivery','bounce','complaint','open','click') GROUP BY e.id,e.campaign_id,v.type ON CONFLICT DO NOTHING;
UPDATE campaign_statistics s SET outcomes = q.outcomes FROM (SELECT campaign_id,jsonb_object_agg(outcome,n) outcomes FROM (SELECT campaign_id,outcome,count(*)::int n FROM campaign_email_outcomes GROUP BY campaign_id,outcome) a GROUP BY campaign_id) q WHERE q.campaign_id=s.campaign_id;
INSERT INTO campaign_daily_statistics SELECT campaign_id,(occurred_at AT TIME ZONE 'UTC')::date,outcome,count(*)::int FROM campaign_email_outcomes GROUP BY 1,2,3;
CREATE INDEX sending_pending_admission ON sending_emails(workspace_id,environment,actor_key_id) WHERE status IN ('queued','attempting');

ALTER TABLE operation_unsubscribe_tokens ADD COLUMN campaign_id text, ADD COLUMN email_id text;
