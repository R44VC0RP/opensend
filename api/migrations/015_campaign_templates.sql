CREATE TABLE IF NOT EXISTS campaign_templates (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  draft jsonb NOT NULL,
  published jsonb,
  published_revision integer,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaign_templates_page ON campaign_templates(workspace_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS template_assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('attachment', 'inline')),
  content_id text,
  storage_key text NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS template_assets_page ON template_assets(workspace_id, id);

CREATE TABLE IF NOT EXISTS template_asset_links (
  workspace_id text NOT NULL,
  asset_id text NOT NULL,
  template_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('draft', 'published')),
  PRIMARY KEY (workspace_id, asset_id, template_id, stage)
);
CREATE INDEX IF NOT EXISTS template_asset_owner ON template_asset_links(workspace_id, template_id, stage);

ALTER TABLE sending_attachments ADD COLUMN IF NOT EXISTS source_template_asset_id text;
ALTER TABLE sending_campaigns ADD COLUMN IF NOT EXISTS source_template_id text;
ALTER TABLE sending_campaigns ADD COLUMN IF NOT EXISTS source_template_revision integer;
