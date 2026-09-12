# OpenSend

Self-hosted transactional and marketing email on Amazon SES. Read `README.md` for the starting points and `api/README.md` for setup, deployment, and operational details.

## Repository map

- `app/` — React/Vite dashboard. `app/index.html` loads `src/main.tsx`; `src/App.tsx` defines routes. Screens live in `src/features/`, shared UI in `src/components/`, API adapters in `src/data/`, and design tokens/styles in `src/styles/`.
- `api/` — Hono API with Zod/OpenAPI schemas. `src/app.ts` assembles routes; `src/server.ts` runs on Node and `src/worker.ts` runs on Cloudflare. `src/runner.ts` runs the Node job worker. PostgreSQL schemas are in `src/db/`, migrations in `migrations/`, and platform/database/storage adapters in `src/adapters/`.
- `sdk/` — Generated TypeScript client, published on npm as `opensend-js`. Usage is in `sdk/README.md`.
- `mcp/` — MCP integration and client connection documentation. See `mcp/README.md`.
- `docs/` — Public demo screenshots, SES research, and `dispatch-scaling.md` (measured throughput ceilings, dispatcher design rationale, and the scaling playbook by SES quota). Prefer `api/README.md` over older research notes for current setup instructions.

The dashboard builds to `app/dist/`. Cloudflare serves that directory; Docker copies it into the API image's `public/` directory. There is no root HTML entry point or root npm workspace.

## Common commands

Run commands from the directory shown; install that package's dependencies first.

| Directory | Command | Purpose |
| --- | --- | --- |
| `app/` | `npm run dev` | Dashboard development server |
| `app/` | `npm run build` | Type-check and build the dashboard |
| `api/` | `npm run dev` / `npm run worker` | Node API / background job worker |
| `api/` | `npm run check` / `npm run sdk` | Type-check API / regenerate OpenAPI and SDK |
| `mcp/` | `npm run check` / `npm run build` | Type-check / compile the MCP adapter |

Docker, Cloudflare, and local development have separate setup instructions in `api/README.md`; do not mix their URLs or configuration.

## Working conventions

- Keep business behavior in the public API. The dashboard, SDK, and MCP use that contract rather than implementing separate sending logic.
- Do not hand-edit `api/openapi.json` or generated `sdk/src/` files. Change the API schemas, then regenerate from `api/` with `npm run sdk`.
- Reuse shared dashboard components and tokens. Preserve OpenTUI Mono, the shared 53px table-row sizing, and concise, installation-neutral copy.
- Keep tests in `api/api.acceptance.test.ts`; do not add separate test files. Run acceptance tests only with an isolated synthetic database/configuration, never production credentials or data.
- After deploying a hosted MCP catalog change, refresh OpenCode with `opencode2 api post /api/mcp/opensend/disconnect` followed by `opencode2 api post /api/mcp/opensend/connect`.
- Use the operator's own deployment resources. Keep credentials, private configuration, database dumps, and real mail out of Git. Ask before provisioning infrastructure, deploying, migrating a live database, or sending real email.
