SET LOCAL lock_timeout='1s';
ALTER TABLE workspaces ADD COLUMN byo_v2_enabled boolean NOT NULL DEFAULT false;
