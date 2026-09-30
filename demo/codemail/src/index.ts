import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { connect, mailboxAccess, member, organization, user } from './db.js';
import type { Directory } from './directory.js';
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
    // The same query loads the organization directory that find_people and name-based recipients use.
    let directory: Directory | undefined;
    if (props?.organizationId) {
      const admin = new OpenSendAdmin(env.OPENSEND_URL, env.OPENSEND_API_KEY, env.MAIL_DOMAIN);
      const connection = connect(env.HYPERDRIVE.connectionString);
      let rows: { userId: string; name: string; email: string; role: string; orgName: string; slug: string }[];
      let allowed = new Set<string>();
      const granted = (props.mailboxes ?? []).map(mailbox => mailbox.id);
      try {
        await connection.ready;
        rows = await connection.db.select({ userId: member.userId, name: user.name, email: user.email, role: member.role, orgName: organization.name, slug: organization.slug })
          .from(member).innerJoin(user, eq(user.id, member.userId)).innerJoin(organization, eq(organization.id, member.organizationId))
          .where(eq(member.organizationId, props.organizationId)).orderBy(asc(user.name));
        // The agent's key covers the mailboxes chosen at sign-in; the person must still have access to each.
        if (granted.length) allowed = new Set((await connection.db.select({ id: mailboxAccess.mailboxId }).from(mailboxAccess).where(and(eq(mailboxAccess.userId, props.userId), inArray(mailboxAccess.mailboxId, granted)))).map(row => row.id));
      } finally { ctx.waitUntil(connection.close()); }
      const stillMember = rows.some(row => row.userId === props.userId);
      const lost = granted.filter(id => !allowed.has(id));
      if (!stillMember || lost.length) {
        ctx.waitUntil(admin.revokeKey(props.keyId).catch(() => {}));
        const reason = !stillMember ? 'You are no longer a member of this organization.' : 'You no longer have access to a mailbox this connection uses. Reconnect codemail to choose mailboxes again.';
        return Response.json({ error: 'invalid_token', error_description: reason }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="OAuth", error="invalid_token"' } });
      }
      const host = `${rows[0]!.slug}.${env.MAIL_DOMAIN}`;
      let agents: Promise<{ address: string; displayName: string | null }[]> | undefined;
      directory = {
        orgName: rows[0]!.orgName, host,
        people: rows.map(({ name, email, role }) => ({ name, email, role })),
        agents: () => agents ??= admin.mailboxes(host).then(list => list.map(({ address, displayName, metadata }) => {
          const owner = typeof metadata?.personalFor === 'string' ? metadata.personalFor : null;
          return { address, displayName, personalOf: owner ? (rows.find(row => row.userId === owner)?.name || 'a former member') : null };
        })),
      };
    }
    // Loaded lazily: with Better Auth in the bundle, esbuild wraps zod in a lazy initializer that the
    // MCP SDK's top-level zod/v4 import would otherwise run before ("ZodLazy is not a constructor").
    const [{ createMcpHandler }, { createServer }] = await Promise.all([import('agents/mcp/server'), import('./mcp.js')]);
    const host = new URL(env.PUBLIC_URL).hostname;
    return createMcpHandler(createServer(env.OPENSEND_URL, directory), { route: '/mcp', allowedHostnames: [host, 'localhost', '127.0.0.1'] })(request, env, ctx);
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
