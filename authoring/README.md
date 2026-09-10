# React Email authoring

OpenSend keeps React source and rendered HTML/text together as immutable, private object-storage artifacts. The dashboard starts an OpenCode v2 session for one template, previews its saved versions, and explicitly publishes a selected version to SES. Creating or saving a draft never sends mail.

Install this package with `npm ci`. It is authoring/migration tooling, not a replacement mail-sending CLI. Use the OpenSend dashboard, public API, SDK, or MCP to operate campaigns.

## Installation

Apply migration `013_template_library.sql` through the normal migration process. Deployment and live migration require operator approval. Configure these values on the API and background worker:

| Variable | Purpose |
| --- | --- |
| `OPENCODE_URL` | Canonical HTTPS origin of the existing OpenCode v2 server; localhost HTTP is allowed for development |
| `OPENCODE_USERNAME`, `OPENCODE_PASSWORD` | OpenCode Basic authentication; username defaults to `opencode` |
| `OPENCODE_TOKEN` | Alternative Bearer authentication if your server uses it |
| `OPENCODE_DIRECTORY` | Writable source root on that server; default `/workspaces/opensend-templates` |
| `OPENCODE_AGENT` | Dedicated author agent name; default `opensend-author` |
| `TEMPLATE_S3_BUCKET`, `TEMPLATE_S3_REGION` | Optional separate private S3 store for source, drafts and image bytes |
| `TEMPLATE_S3_ACCESS_KEY_ID`, `TEMPLATE_S3_SECRET_ACCESS_KEY` | Credentials scoped to that store |

Without `TEMPLATE_S3_BUCKET`, artifacts use the existing installation object store (S3 on Node, R2 on Cloudflare). S3 requires private `GetObject`, `PutObject`, `DeleteObject` access to the OpenSend namespace. Source bundles must never have public bucket access. Uploaded raster images are deliberately served at immutable public `/template-assets/:id` URLs; upload only content intended to appear in email. Existing absolute image URLs remain usable.

Configure the dedicated agent on the existing OpenCode server before enabling it. Give it this package, Node, dependency installation, and only its authoring workspace. Do not expose production credentials, CRM connections, SES privileges, general OpenSend API keys, or unrelated workspaces to that agent. A per-template directory is an organizational boundary; enforce filesystem/process isolation on the operator's OpenCode deployment. The API capability expires after 24 hours and allows only that template's restore, draft save, and image upload callbacks. Stop authoring revokes it and cancels pending instructions. Publishing is an independent authenticated `manage` operation.

The adapter uses OpenCode v2 `/api/session`, `/api/session/:id/prompt`, `/message`, and `/interrupt`. Prompt admission is durable and message IDs are stable across retries. Check the authoring panel for connection errors. A failed request can be resubmitted after correcting configuration.

## Author workflow

Set `OPENSEND_URL`, `OPENSEND_TEMPLATE_ID`, and the session's `OPENSEND_TEMPLATE_TOKEN` in the isolated author process, never in committed files. Run commands from this package:

```sh
npm run restore -- /workspaces/opensend-templates/example
# Install the restored project's pinned dependencies and edit its React source.
npm run build -- /workspaces/opensend-templates/example emails/example.tsx
npm run save -- /workspaces/opensend-templates/example emails/example.tsx
```

Restore requires an empty destination, records the base revision, and bundles all relative imports. Save checks TypeScript and renders HTML and text, then uses that recorded revision; concurrent changes fail instead of being overwritten. Keep `metadata.subject`, `metadata.previewText`, and optional `metadata.sesName` exports with the component. Use simple `{{fieldName}}` placeholders and `{{unsubscribeUrl}}` for a marketing unsubscribe link. The API appends a footer when needed and rechecks current consent/suppression before dispatch. Automation templates may omit preview text (`OPENSEND_TEMPLATE_KIND=automation`).

SES publication creates an immutable `os_<version-id>` template in the selected region. SES credentials need `ses:CreateEmailTemplate` and `ses:GetEmailTemplate` for that prefix in addition to existing sending permissions. Updating a legacy name also requires `ses:UpdateEmailTemplate` (and create if absent) for those explicitly approved legacy names. Check the exact `sesName` returned by the API when constructing IAM resources. A version has one publication region; save a new version for another region.

The legacy update checkbox explicitly updates `metadata.sesName`, preserving Magento's existing SES template names and external automation triggers. OpenSend does not take over Magento trigger execution. Existing campaigns keep their selected immutable version when a newer draft is saved or published. Do not update a legacy automation until its required fields have been checked against Magento's actual payloads.

## Importing the existing React Email project

Run the audit first, using a local source checkout with its dependencies installed:

```sh
npm run import -- /path/to/react-emails
```

Only `emails/mailers/ready/**/*.tsx` and `emails/automations/**/*.tsx` are candidates. Drafts, outputs, private environment files, and credentials are excluded. Each candidate is type-checked/rendered, its local imports bundled, direct dependencies pinned, and its SES name preserved. The known historical marketing unsubscribe link is converted to `{{unsubscribeUrl}}`. The report is written to `reports/opensend-import.json`; inspect every failure.

To import validated drafts, set an unrestricted OpenSend `manage` key as `OPENSEND_API_KEY`, select its intended environment, and set `OPENSEND_IMPORT_WRITE=1`. Reruns reuse template IDs recorded in the report; keep that report local and use it with the same OpenSend installation/environment. There is a small crash window between remote template creation and the local checkpoint; reconcile any empty duplicate before retrying that interrupted creation. Import never publishes to SES. Review and publish each approved migration in the dashboard. Retain the old project until required marketing and automation templates are verified.

The existing source project audit on 2026-09-10 rendered all 93 ready/automation candidates successfully in an isolated temporary copy. The compiler uses the source project's JSX configuration and shares one scoped loader across the audit, avoiding repeated module graphs. No source repository, SES templates, or live campaigns were modified by that audit.
