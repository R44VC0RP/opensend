# opensend

Self-hosted transactional email, newsletters, and campaigns with Amazon SES. One installation, Google-only sign-in, and one public API shared by the dashboard, SDK, and MCP server. No passwords, teams, or browser-side API-secret setup.

![opensend dashboard showing sending activity, delivery metrics, and recent campaigns](docs/images/dashboard.png)

<p>
  <a href="docs/images/campaign-composer.png"><img src="docs/images/campaign-composer.png" alt="Campaign composer with visual email editing and audience selection" width="49%" /></a>
  <a href="docs/images/email-logs.png"><img src="docs/images/email-logs.png" alt="Email logs with delivery statuses, recipients, and filtering" width="49%" /></a>
</p>

## Start here

1. Clone the repo:

   ```sh
   git clone https://github.com/R44VC0RP/opensend.git
   cd opensend
   ```

2. Open the repo in your coding agent and paste:

   ```text
   Help me set up OpenSend for my use case. Explore this repo and read
   api/README.md first. Ask what I want to send, whether I prefer Docker
   or Cloudflare, and what infrastructure I already have. Recommend the
   simplest setup and explain the plan before making changes. Use my own
   accounts and resources, keep secrets out of git, and start with simulated
   sending. Ask before provisioning, deploying, or sending real email.
   ```

Prefer a manual setup? Start with [Docker](api/README.md#docker-quickstart) or [Cloudflare](api/README.md#cloudflare). For development, see the [local setup](api/README.md#local-development).

## TypeScript SDK

Install [`opensend-js`](https://www.npmjs.com/package/opensend-js) from npm:

```sh
npm install opensend-js
```

See the [SDK guide](sdk/README.md) for usage examples, or [connect an MCP client](mcp/README.md).

Template authoring and migration: [authoring/README.md](authoring/README.md).
