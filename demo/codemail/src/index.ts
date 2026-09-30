import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { authHandler, type Env } from './auth.js';
import { createServer } from './mcp.js';

// The MCP endpoint receives the OAuth grant's props (the connected mailbox key) as ctx.props.
const mcpApi = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const host = new URL(env.PUBLIC_URL).hostname;
    return createMcpHandler(createServer(env.OPENSEND_URL), { route: '/mcp', allowedHostnames: [host, 'localhost', '127.0.0.1'] })(request, env, ctx);
  },
};

// Built once per isolate and origin; the options depend only on configuration.
let provider: { origin: string; value: OAuthProvider<Env> } | undefined;
function oauth(env: Env) {
  const origin = env.PUBLIC_URL.replace(/\/$/, '');
  if (provider?.origin === origin) return provider.value;
  provider = { origin, value: new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpApi,
      defaultHandler: authHandler,
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
