-- A campaign snapshot inserts every reviewed recipient in one statement (up to 2,000,000 rows). The
-- foreign key to sending_campaign_reviews ran its referential check once per inserted row, which was
-- about a third of a 1.9M-recipient snapshot. Recipients are only ever inserted by that statement,
-- right after their review row in the same transaction, so the per-row insert check is replaced by a
-- statement-level cascade that keeps the ON DELETE CASCADE behavior.
ALTER TABLE sending_review_recipients DROP CONSTRAINT IF EXISTS sending_review_recipients_review_id_fkey;
CREATE OR REPLACE FUNCTION delete_review_recipients() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM sending_review_recipients r USING deleted_reviews d WHERE r.review_id = d.id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS sending_review_recipients_cascade ON sending_campaign_reviews;
CREATE TRIGGER sending_review_recipients_cascade AFTER DELETE ON sending_campaign_reviews
  REFERENCING OLD TABLE AS deleted_reviews FOR EACH STATEMENT EXECUTE FUNCTION delete_review_recipients();
