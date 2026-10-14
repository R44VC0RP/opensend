-- Overview metrics re-aggregated every email-bearing operation event in the window (400k+ for 7 days) on
-- every query, four queries per page load. Each email now carries the union of its public event outcomes
-- as bit flags, maintained by a statement-level trigger on every operation_events insert path, so metrics
-- read sending_emails only. Bits: 1 accepted (sent, delivered, bounced, complained, delivery_delayed),
-- 2 delivered, 4 bounced, 8 complained, 16 opened, 32 clicked, 64 failed (rejected, rendering_failed),
-- 128 delivery delayed. ADD COLUMN with a constant default does not rewrite the table; existing rows are
-- backfilled separately (bitwise OR, so the backfill and the trigger commute).
ALTER TABLE sending_emails ADD COLUMN IF NOT EXISTS event_outcomes smallint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION record_email_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Rows are locked in id order, as every other multi-email writer does, so this cannot add a deadlock.
  WITH bits AS (
    SELECT n.workspace_id, n.environment, n.data->>'emailId' AS email_id,
      bit_or(CASE n.type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3 WHEN 'email.bounced' THEN 5
        WHEN 'email.complained' THEN 9 WHEN 'email.delivery_delayed' THEN 129 WHEN 'email.opened' THEN 16
        WHEN 'email.clicked' THEN 32 WHEN 'email.rejected' THEN 64 WHEN 'email.rendering_failed' THEN 64 ELSE 0 END) AS bits
    FROM new_events n WHERE n.data ? 'emailId' GROUP BY 1, 2, 3
  ), targets AS (
    SELECT e.id, b.bits::smallint AS bits FROM sending_emails e
    JOIN bits b ON e.id = b.email_id AND e.workspace_id = b.workspace_id AND e.environment = b.environment
    WHERE b.bits <> 0 AND (e.event_outcomes | b.bits::smallint) <> e.event_outcomes
    ORDER BY e.id FOR UPDATE OF e
  )
  UPDATE sending_emails e SET event_outcomes = e.event_outcomes | t.bits FROM targets t WHERE e.id = t.id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS operation_events_email_outcomes ON operation_events;
CREATE TRIGGER operation_events_email_outcomes AFTER INSERT ON operation_events
  REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION record_email_event_outcomes();
