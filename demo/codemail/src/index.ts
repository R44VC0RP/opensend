import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { and, eq } from 'drizzle-orm';
import { connect, member } from './db.js';
import type { Env } from './env.js';
import type { CodemailProps } from './mcp.js';
import { OpenSendAdmin } from './opensend.js';
import { createWeb } from './web.js';

const web = createWeb();

// The MCP endpoint receives the OAuth grant's props (the minted mailbox key) as ctx.props.
const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const props = ctx.props as CodemailProps | undefined;
    // Access follows organization membership: someone removed from the organization loses their agents at once.
    if (props?.organizationId) {
      const connection = connect(env.HYPERDRIVE.connectionString);
      try {
        await connection.ready;
        const [row] = await connection.db.select({ id: member.id }).from(member).where(and(eq(member.userId, props.userId), eq(member.organizationId, props.organizationId)));
        if (!row) {
          ctx.waitUntil(new OpenSendAdmin(env.OPENSEND_URL, env.OPENSEND_API_KEY, env.MAIL_DOMAIN).revokeKey(props.keyId).catch(() => {}));
          return Response.json({ error: 'invalid_token', error_description: 'You are no longer a member of this organization.' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="OAuth", error="invalid_token"' } });
        }
      } finally { ctx.waitUntil(connection.close()); }
    }
    // Loaded lazily: with Better Auth in the bundle, esbuild wraps zod in a lazy initializer that the
    // MCP SDK's top-level zod/v4 import would otherwise run before ("ZodLazy is not a constructor").
    const [{ createMcpHandler }, { createServer }] = await Promise.all([import('agents/mcp/server'), import('./mcp.js')]);
    const host = new URL(env.PUBLIC_URL).hostname;
    return createMcpHandler(createServer(env.OPENSEND_URL), { route: '/mcp', allowedHostnames: [host, 'localhost', '127.0.0.1'] })(request, env, ctx);
  },
};

// Built once per isolate and origin; the options depend only on configuration.
let provider: { origin: string; value: OAuthProvider<Env> } | undefined;
function oauth(env: Env) {
  const origin = new URL(env.PUBLIC_URL).origin;
  if (provider?.origin === origin) return provider.value;
  provider = { origin, value: new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: mcpApi,
    defaultHandler: web,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: ['mail', 'offline_access'],
    requiredScopes: ['mail'],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'codemail' },
    clientIdMetadataDocumentEnabled: true,
  }) };
  return provider.value;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) { return oauth(env).fetch(request, env, ctx); },
} satisfies ExportedHandler<Env>;
