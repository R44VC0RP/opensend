-- Apply with mail writers drained. The snapshot and trigger installation must be atomic.
LOCK TABLE sending_emails, sending_email_events IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE sending_campaigns DROP CONSTRAINT sending_campaigns_waiting_reason_check,
  ADD CHECK (waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota'));
-- A workspace may disconnect or switch to BYO. Operator policy survives, but is
-- only consulted while the workspace has a Hosted connection.
ALTER TABLE workspaces
  ADD COLUMN send_cap_override integer CHECK (send_cap_override BETWEEN 1 AND 10000000),
  ADD COLUMN pending_cap_override integer CHECK (pending_cap_override BETWEEN 1 AND 4000000);

CREATE TABLE hosted_usage_hourly (
  workspace_id text NOT NULL, hour timestamptz NOT NULL, recipients bigint NOT NULL,
  PRIMARY KEY (workspace_id,hour)
);
CREATE FUNCTION hosted_real_cost(addresses jsonb) RETURNS integer LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT count(*)::int FROM jsonb_array_elements_text(addresses) a WHERE lower(a) NOT LIKE '%@simulator.amazonses.com'
$$;
CREATE FUNCTION hosted_charged(status text, provider_id text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT status NOT IN ('suppressed','canceled','simulated') AND (provider_id IS NOT NULL OR status NOT IN ('rejected','rendering_failed'))
$$;
-- The queued row belongs to the current connection; an attempted row carries the immutable provider topic.
CREATE VIEW hosted_real_envelopes AS SELECT e.id,e.workspace_id,e.created_at,e.status,e.provider_id,
  hosted_real_cost(e.to_addresses || e.cc_addresses || e.bcc_addresses) AS cost
  FROM sending_emails e LEFT JOIN provider_connections pc USING (workspace_id)
  WHERE NOT e.simulated AND ((e.feedback_topic_arn IS NULL AND pc.kind='shared') OR e.feedback_topic_arn IN
    (SELECT feedback_topic_arn FROM provider_pool_regions WHERE feedback_topic_arn IS NOT NULL));

INSERT INTO hosted_usage_hourly SELECT workspace_id,date_trunc('hour',created_at,'UTC'),sum(cost)
  FROM hosted_real_envelopes WHERE created_at >= date_trunc('hour',now(),'UTC')-interval '23 hours' AND hosted_charged(status,provider_id)
  GROUP BY 1,2;
-- One counter write per workspace/hour in a batch admission or campaign release, not per envelope.
CREATE FUNCTION hosted_charge_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hosted_usage_hourly AS u SELECT n.workspace_id,date_trunc('hour',n.created_at,'UTC'),sum(hosted_real_cost(n.to_addresses || n.cc_addresses || n.bcc_addresses))
    FROM new_mail n LEFT JOIN provider_connections pc USING (workspace_id) WHERE NOT n.simulated AND hosted_charged(n.status,n.provider_id)
    AND ((n.feedback_topic_arn IS NULL AND pc.kind='shared') OR n.feedback_topic_arn IN (SELECT feedback_topic_arn FROM provider_pool_regions))
    GROUP BY 1,2 ORDER BY 1,2 ON CONFLICT (workspace_id,hour) DO UPDATE SET recipients=u.recipients+excluded.recipients;
  RETURN NULL;
END $$;
CREATE TRIGGER hosted_admit AFTER INSERT ON sending_emails REFERENCING NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION hosted_charge_batch();

-- Ordinary leasing, successful dispatch and duplicate outcomes never touch the counter. Refund the
-- original admission hour, not the hour in which cancellation, suppression or rejection was learned.
CREATE FUNCTION hosted_adjust_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT FROM hosted_real_envelopes WHERE workspace_id=NEW.workspace_id AND id=NEW.id) THEN RETURN NULL; END IF;
  n := hosted_real_cost(NEW.to_addresses || NEW.cc_addresses || NEW.bcc_addresses);
  INSERT INTO hosted_usage_hourly AS u SELECT NEW.workspace_id,h,sum(delta) FROM (VALUES
    (date_trunc('hour',OLD.created_at,'UTC'),-n*hosted_charged(OLD.status,OLD.provider_id)::int),
    (date_trunc('hour',NEW.created_at,'UTC'), n*hosted_charged(NEW.status,NEW.provider_id)::int)) d(h,delta)
    WHERE h >= date_trunc('hour',now(),'UTC')-interval '23 hours' GROUP BY h HAVING sum(delta)<>0 ORDER BY h
    ON CONFLICT (workspace_id,hour) DO UPDATE SET recipients=u.recipients+excluded.recipients;
  RETURN NULL;
END $$;
CREATE TRIGGER hosted_adjust AFTER UPDATE OF status,provider_id,created_at ON sending_emails FOR EACH ROW
  WHEN (NOT NEW.simulated AND (hosted_charged(OLD.status,OLD.provider_id)<>hosted_charged(NEW.status,NEW.provider_id) OR OLD.created_at<>NEW.created_at))
  EXECUTE FUNCTION hosted_adjust_usage();

-- The review timestamp is the reputation epoch: resume immediately disregards all earlier
-- credits, including those in the same hour. Usage is independent and is never reset by resume.
CREATE TABLE hosted_health_hourly (workspace_id text NOT NULL, epoch timestamptz NOT NULL, hour timestamptz NOT NULL,
  accepted bigint NOT NULL, bounces bigint NOT NULL, complaints bigint NOT NULL, PRIMARY KEY(workspace_id,epoch,hour));
-- Remember the contribution of each envelope so retries, a later accepted/Send callback,
-- overlapping recipient hashes, and a subsequent SES validation suppression adjust it exactly once.
CREATE TABLE hosted_health_credits (workspace_id text NOT NULL, email_id text NOT NULL, epoch timestamptz NOT NULL, hour timestamptz NOT NULL,
  accepted integer NOT NULL, bounces integer NOT NULL, complaints integer NOT NULL, PRIMARY KEY(workspace_id,email_id,epoch,hour));
CREATE INDEX hosted_health_credits_retire ON hosted_health_credits(hour);

CREATE VIEW hosted_health_projection AS WITH latest AS (
  SELECT v.workspace_id,v.email_id,coalesce(pc.resumed_at,'-infinity') AS epoch,e.cost,
    CASE WHEN v.type IN ('accepted','send') THEN 'accepted' ELSE v.type END kind,
    coalesce(h.hash,'') AS dest,max(v.created_at) AS at
    FROM sending_email_events v JOIN hosted_real_envelopes e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    JOIN provider_connections pc ON pc.workspace_id=v.workspace_id AND pc.kind='shared'
    LEFT JOIN LATERAL unnest(v.recipient_hashes) h(hash) ON v.type IN ('bounce','complaint')
    WHERE NOT v.simulated AND e.cost>0 AND e.status<>'suppressed' AND v.created_at>coalesce(pc.resumed_at,'-infinity')
      AND v.created_at>=date_trunc('hour',now(),'UTC')-interval '47 hours'
      AND (v.type IN ('accepted','send','complaint') OR (v.type='bounce' AND v.data->>'bounceType'='Permanent'))
      AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes)>0)
    GROUP BY 1,2,3,4,5,6
), ranked AS (
  SELECT *,row_number() OVER (PARTITION BY workspace_id,email_id,kind ORDER BY (dest<>'') DESC,at DESC,dest) AS pos,
    max(at) FILTER(WHERE dest='') OVER (PARTITION BY workspace_id,email_id,kind) AS unknown_at FROM latest
) SELECT workspace_id,email_id,epoch,date_trunc('hour',CASE WHEN pos=1 THEN greatest(at,unknown_at) ELSE at END,'UTC') AS hour,
  coalesce(sum(cost) FILTER(WHERE kind='accepted'),0)::int AS accepted,count(*) FILTER(WHERE kind='bounce')::int AS bounces,
  count(*) FILTER(WHERE kind='complaint')::int AS complaints
  FROM ranked WHERE dest<>'' OR pos=1 GROUP BY 1,2,3,4;

INSERT INTO hosted_health_credits SELECT * FROM hosted_health_projection;
INSERT INTO hosted_health_hourly SELECT workspace_id,epoch,hour,sum(accepted),sum(bounces),sum(complaints) FROM hosted_health_credits GROUP BY 1,2,3;

-- Reconcile only the affected envelope, using the existing (workspace_id,email_id) event index.
-- Both a feedback insert and a suppression in the same statement may fire: the stored credits
-- make their ordering irrelevant. The dispatch/feedback statements already serialize on the email.
CREATE FUNCTION hosted_refresh_health(wid text,eid text) RETURNS void LANGUAGE sql AS $$
  WITH wanted AS MATERIALIZED (SELECT * FROM hosted_health_projection WHERE workspace_id=wid AND email_id=eid),
  old AS MATERIALIZED (SELECT * FROM hosted_health_credits WHERE workspace_id=wid AND email_id=eid),
  removed AS (DELETE FROM hosted_health_credits c WHERE c.workspace_id=wid AND c.email_id=eid
    AND NOT EXISTS (SELECT FROM wanted w WHERE (w.epoch,w.hour)=(c.epoch,c.hour)) RETURNING c.*),
  changed AS (INSERT INTO hosted_health_credits AS c SELECT * FROM wanted ON CONFLICT(workspace_id,email_id,epoch,hour) DO UPDATE
    SET accepted=excluded.accepted,bounces=excluded.bounces,complaints=excluded.complaints
    WHERE (c.accepted,c.bounces,c.complaints)<>(excluded.accepted,excluded.bounces,excluded.complaints) RETURNING *),
  deltas AS (SELECT epoch,hour,-accepted AS a,-bounces AS b,-complaints AS c FROM removed UNION ALL
    SELECT n.epoch,n.hour,n.accepted-coalesce(o.accepted,0),n.bounces-coalesce(o.bounces,0),n.complaints-coalesce(o.complaints,0)
    FROM changed n LEFT JOIN old o USING(epoch,hour))
  INSERT INTO hosted_health_hourly AS totals SELECT wid,epoch,hour,a,b,c FROM deltas ORDER BY epoch,hour
  ON CONFLICT(workspace_id,epoch,hour) DO UPDATE SET accepted=totals.accepted+excluded.accepted,bounces=totals.bounces+excluded.bounces,complaints=totals.complaints+excluded.complaints
$$;
CREATE FUNCTION hosted_health_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT FROM provider_connections WHERE workspace_id=NEW.workspace_id AND kind='shared') THEN
    PERFORM hosted_refresh_health(NEW.workspace_id,NEW.email_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER hosted_health_feedback AFTER INSERT ON sending_email_events FOR EACH ROW WHEN
  (NOT NEW.simulated AND (NEW.type IN ('accepted','send','complaint') OR (NEW.type='bounce' AND NEW.data->>'bounceType'='Permanent'))) EXECUTE FUNCTION hosted_health_event();
CREATE FUNCTION hosted_health_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT FROM provider_connections WHERE workspace_id=NEW.workspace_id AND kind='shared') THEN PERFORM hosted_refresh_health(NEW.workspace_id,NEW.id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER hosted_health_suppressed AFTER UPDATE OF status ON sending_emails FOR EACH ROW WHEN
  (NOT NEW.simulated AND (OLD.status='suppressed')<>(NEW.status='suppressed')) EXECUTE FUNCTION hosted_health_suppression();
