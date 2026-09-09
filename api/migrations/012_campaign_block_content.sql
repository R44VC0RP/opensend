-- Campaign content is block HTML rendered by the server. Composer editor metadata is no
-- longer stored; the dashboard reopens drafts from html. Drafts whose html predates the
-- block vocabulary stay readable and are revalidated when saved or reviewed.

UPDATE sending_campaigns SET draft = draft - 'editor' WHERE draft ? 'editor';
UPDATE sending_campaign_reviews SET draft = draft - 'editor' WHERE draft ? 'editor';
