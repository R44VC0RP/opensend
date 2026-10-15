-- SES Auto Validation drops risky recipients before sending and reports each drop as a Permanent bounce with
-- bounceSubType EmailValidationSuppressed. The message never left SES and AWS excludes it from
-- Reputation.BounceRate, so its email.bounced event must not set the bounced (or accepted) outcome bits used by
-- Overview metrics; the email itself becomes suppressed. Only the trigger function body changes: CREATE OR REPLACE
-- FUNCTION rewrites no table rows and the existing trigger picks up the new body on its next statement.
CREATE OR REPLACE FUNCTION record_email_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Rows are locked in id order, as every other multi-email writer does, so this cannot add a deadlock.
  WITH bits AS (
    SELECT n.workspace_id, n.environment, n.data->>'emailId' AS email_id,
      bit_or(CASE n.type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3
        WHEN 'email.bounced' THEN CASE WHEN n.data->>'bounceSubType' = 'EmailValidationSuppressed' THEN 0 ELSE 5 END
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
