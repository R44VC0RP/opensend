-- Campaign drafts are HTML only. Fold any legacy plain-text bodies into simple HTML
-- (escaped text, blank lines as paragraphs, single newlines as <br>) and drop the key.
-- Reviews keep their snapshot but no longer match their content hash, so affected
-- campaigns must be reviewed again before sending.

CREATE OR REPLACE FUNCTION pg_temp.opensend_text_to_html(body text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '<p>' || replace(replace(replace(replace(replace(replace(replace(body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), E'\r\n', E'\n'), E'\n\n', '</p><p>'), E'\n', '<br>'), '<p></p>', '') || '</p>'
$$;

UPDATE sending_campaigns
  SET draft = (draft - 'text') || jsonb_build_object('html', pg_temp.opensend_text_to_html(draft->>'text'))
  WHERE draft ? 'text' AND coalesce(draft->>'html', '') = '' AND coalesce(draft->>'text', '') <> '';

UPDATE sending_campaign_reviews
  SET draft = (draft - 'text') || jsonb_build_object('html', pg_temp.opensend_text_to_html(draft->>'text'))
  WHERE draft ? 'text' AND coalesce(draft->>'html', '') = '' AND coalesce(draft->>'text', '') <> '';

UPDATE sending_campaigns SET draft = draft - 'text' WHERE draft ? 'text';
UPDATE sending_campaign_reviews SET draft = draft - 'text' WHERE draft ? 'text';
