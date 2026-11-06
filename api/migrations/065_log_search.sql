CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Only text and JSON string arrays; no locale/timezone-dependent timestamp formatting.
CREATE FUNCTION sending_log_text(eid text,campaign text,provider text,sender text,subject text,recipients jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT concat_ws(' ',eid,campaign,provider,sender,subject) || E'\n' ||
    coalesce((SELECT string_agg(address,E'\n' ORDER BY ordinal) FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(address,ordinal)),'')
$$;

-- On a large live log prebuild this index CONCURRENTLY before the transactional migration.
CREATE INDEX IF NOT EXISTS sending_emails_log_trgm ON sending_emails USING gin
  (sending_log_text(id,campaign_id,provider_id,from_address,subject,to_addresses || cc_addresses || bcc_addresses) gin_trgm_ops);
