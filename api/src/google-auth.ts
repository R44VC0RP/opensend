import { createRoute, z } from '@hono/zod-openapi';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { google, verifyGoogleIdToken } from 'better-auth/social-providers';
import { jwt } from 'better-auth/plugins';
import { createMcpPlugin, isMcpAuthPath } from './mcp-auth.js';
import { mcpAuthSchema } from './db/mcp-auth.js';
import { and, eq, exists, gt, inArray, ne, sql } from 'drizzle-orm';
import { isSimulatedSes, ApiError, errors, log, response, security, timed } from './core.js';
import type { Actor, App, DbExecutor, Runtime } from './core.js';
import { authAccount, authSession, authUser, googleAuthSchema } from './db/google-auth.js';
import { workspaceMembers } from './db/workspaces.js';
import { claimInvitation, onboardNewUser, WorkspaceRole } from './workspaces.js';
import { ConnectionSummary, connectionSummary } from './provider-connections.js';

const day = 24 * 60 * 60;

function configured(runtime: Runtime) {
  return Boolean(runtime.config.googleClientId && runtime.config.googleClientSecret && runtime.config.authSecret);
}
function requireConfigured(runtime: Runtime) {
  if (!configured(runtime)) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Google sign-in is not configured for this deployment.');
}
export function approvedGoogleIdentity(runtime: Runtime, email: unknown, emailVerified: unknown, hostedDomain: unknown) {
  if (!configured(runtime)) return false;
  if (emailVerified !== true || typeof email !== 'string' || !email) return false;
  return runtime.config.allowedEmails.includes(email.toLowerCase()) ||
    (typeof hostedDomain === 'string' && hostedDomain !== '' && runtime.config.allowedDomains.includes(hostedDomain.toLowerCase()));
}

export function currentGoogleIdentity(runtime: Runtime, email: string, verified: boolean, hd: string | null) {
  return runtime.config.multiTenant ? configured(runtime) && !!email && verified : approvedGoogleIdentity(runtime, email, verified, hd);
}

async function approvedUser(runtime: Runtime, userId: string, db: DbExecutor, session?: { id: string; token: string }, requireMembership = true) {
  if (!configured(runtime)) return null;
  // Better Auth's signed cookie authenticates the presented session, not its continued validity.
  // Read the current session, Google link and identity in one query even on a warm cookie-cache hit.
  const liveSession = session && exists(db.select({ id: authSession.id }).from(authSession).where(and(
    eq(authSession.id, session.id), eq(authSession.token, session.token), eq(authSession.userId, authUser.id), gt(authSession.expiresAt, sql`now()`),
  )));
  const [user] = await db.select({ email: authUser.email, name: authUser.name, emailVerified: authUser.emailVerified, googleHostedDomain: authUser.googleHostedDomain })
    .from(authUser).innerJoin(authAccount, and(eq(authAccount.userId, authUser.id), eq(authAccount.providerId, 'google'), ne(authAccount.accountId, '')))
    .where(and(eq(authUser.id, userId), liveSession, runtime.config.multiTenant && requireMembership ? exists(db.select({ id: workspaceMembers.id }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, authUser.id), inArray(workspaceMembers.role, WorkspaceRole.options)))) : undefined)).limit(1).for('share');
  // With a transaction executor, hold the approved user/account through dispatch's claim.
  return user && currentGoogleIdentity(runtime, user.email, user.emailVerified, user.googleHostedDomain) ? user : null;
}

export async function isApprovedUser(runtime: Runtime, userId: string, db: DbExecutor = runtime.db): Promise<boolean> {
  return Boolean(await approvedUser(runtime, userId, db));
}

// Only call after Google verification. Self-hosted ambiguous logins fail closed;
// an existing consent may select only its bound workspace in either mode.
export async function membershipForApprovedUser(db: DbExecutor, userId: string, { workspaceId, bootstrapDefaultOwner, multiTenant }: { workspaceId?: string; bootstrapDefaultOwner: boolean; multiTenant?: boolean }) {
  const fields = { workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role };
  if (multiTenant) {
    const [row] = await db.select(fields).from(workspaceMembers).innerJoin(authUser, eq(authUser.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.userId, userId), workspaceId === undefined ? undefined : eq(workspaceMembers.workspaceId, workspaceId)))
      .orderBy(sql`(${workspaceMembers.workspaceId} = ${authUser.selectedWorkspaceId}) DESC NULLS LAST`, workspaceMembers.createdAt, workspaceMembers.id).limit(1).for('share');
    return WorkspaceRole.safeParse(row?.role).success ? row : null;
  }
  const memberships = () => db.select(fields).from(workspaceMembers).where(eq(workspaceMembers.userId, userId)).for('share');
  let rows = await memberships();
  if (!rows.length && workspaceId === undefined && bootstrapDefaultOwner) {
    rows = await db.insert(workspaceMembers).values({ id: crypto.randomUUID(), userId, workspaceId: 'default', role: 'owner' })
      .onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.userId] }).returning(fields);
    if (!rows.length) rows = await memberships(); // Concurrent first use; read the winner's role.
  }
  const member = workspaceId !== undefined ? rows.find(row => row.workspaceId === workspaceId) : rows.length === 1 ? rows[0] : null;
  return member && (member.role === 'owner' || member.role === 'admin') ? member : null;
}

// Called per runtime/request: never retain a Workers connection in a module-global auth instance.
export function createAuth(runtime: Runtime, consentWorkspace?: string) {
  requireConfigured(runtime);
  const origin = new URL(runtime.config.publicUrl).origin;
  const secure = origin.startsWith('https:');
  const googleProvider = google({ clientId: runtime.config.googleClientId!, clientSecret: runtime.config.googleClientSecret! });
  // Better Auth intentionally drops input:false fields from mapProfileToUser. Only
  // its verified OAuth lifecycle gate can supply this protected database field.
  const profiles = new WeakMap<object, { email: string; subject: string; hostedDomain: string | null; returning: boolean }>();
  const profileFor = (context: object | null) => {
    const profile = context && profiles.get(context);
    if (!profile) throw new APIError('FORBIDDEN', { code: 'GOOGLE_IDENTITY_REQUIRED', message: 'An approved Google identity is required.' });
    return profile;
  };
  const noTokens = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scope: null, password: null };
  const adapterConfig = { provider: 'pg' as const, schema: { ...googleAuthSchema, ...mcpAuthSchema } };
  const database: ReturnType<typeof drizzleAdapter> = options => {
    const adapter = drizzleAdapter(runtime.db, { ...adapterConfig, transaction: true })(options);
    if (runtime.config.multiTenant) {
      // BA creates the user and provider link inside this transaction. Enroll the new user here,
      // not in an after hook (BA runs those *after commit*) or during an ordinary session read.
      adapter.transaction = work => runtime.db.transaction(async tx => {
        const scoped = drizzleAdapter(tx, adapterConfig)(options), create = scoped.create;
        async function onboard<T>(pending: Promise<T>): Promise<T> {
          const result = await pending;
          const user = z.object({ id: z.string(), email: z.email(), name: z.string(), emailVerified: z.literal(true), googleHostedDomain: z.string().nullish() }).parse(result);
          if (!await onboardNewUser(tx, user, approvedGoogleIdentity(runtime, user.email, true, user.googleHostedDomain), runtime.config.regions[0]!)) throw new APIError('FORBIDDEN', { code: 'GOOGLE_ACCESS_DENIED', message: 'This account is not approved for sign-up.' });
          return result;
        }
        scoped.create = input => input.model === 'user' ? onboard(create(input)) : create(input);
        return work(scoped);
      });
    }
    return adapter;
  };
  return betterAuth({
    appName: 'OpenSend', baseURL: origin, basePath: '/api/auth', secret: runtime.config.authSecret,
    database,
    plugins: [jwt({ disableSettingJwtHeader: true, jwt: { issuer: `${origin}/api/auth` }, jwks: { keyPairConfig: { alg: 'ES256' } } }), createMcpPlugin(runtime, consentWorkspace)],
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false, disableSignUp: true },
    socialProviders: {
      google: {
        clientId: runtime.config.googleClientId!, clientSecret: runtime.config.googleClientSecret!,
        accessType: 'online', disableDefaultScope: true, scope: ['openid', 'email', 'profile'], includeGrantedScopes: false,
        disableIdTokenSignIn: true, requireEmailVerification: true, overrideUserInfoOnSignIn: true,
        getUserInfo: async tokens => {
          if (!tokens.idToken) return null;
          // BA 1.7.3's code callback otherwise only decodes Google's ID token.
          // Use its exported RS256/JWKS verifier before any hd/profile admission;
          // the library still owns code exchange, PKCE and one-use OAuth state.
          const nonce = 'expectedIdTokenNonce' in tokens && typeof tokens.expectedIdTokenNonce === 'string' ? tokens.expectedIdTokenNonce : undefined;
          const claims = await verifyGoogleIdToken({ token: tokens.idToken, audience: runtime.config.googleClientId!, nonce });
          if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
          return googleProvider.getUserInfo(tokens);
        },
      },
    },
    user: {
      additionalFields: { googleHostedDomain: { type: 'string', required: false, input: false, returned: false } },
      changeEmail: { enabled: false }, deleteUser: { enabled: false },
      validateUserInfo: ({ user, source }, context) => {
        const profile = source.oauth?.profile;
        if (source.method !== 'oauth' || source.oauth?.providerId !== 'google' || source.action === 'link-account' ||
          typeof profile?.sub !== 'string' || !profile.sub || typeof profile.email !== 'string' ||
          user.email?.toLowerCase() !== profile.email.toLowerCase() || user.emailVerified !== true ||
          profile.email_verified !== true || (!runtime.config.multiTenant && !approvedGoogleIdentity(runtime, profile.email, profile.email_verified, profile.hd))) {
          return { error: 'GOOGLE_ACCESS_DENIED', errorDescription: 'This Google identity is not approved.' };
        }
        profiles.set(context, { email: profile.email.toLowerCase(), subject: profile.sub, hostedDomain: typeof profile.hd === 'string' ? profile.hd.toLowerCase() : null, returning: source.action === 'sign-in' });
      },
    },
    session: { expiresIn: 7 * day, updateAge: day, cookieCache: { enabled: true, maxAge: 60 } },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true }, encryptOAuthTokens: true,
      storeAccountCookie: false, storeStateStrategy: 'database', skipStateCookieCheck: false,
    },
    advanced: {
      cookiePrefix: 'opensend', useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false, disableCSRFCheck: false, disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ['x-opensend-client-ip'] },
    },
    databaseHooks: {
      user: {
        create: { before: async (user, context) => {
          const profile = profileFor(context);
          if (user.email.toLowerCase() !== profile.email || user.emailVerified !== true) throw new APIError('FORBIDDEN');
          return { data: { ...user, googleHostedDomain: profile.hostedDomain } };
        } },
        update: { before: async (user, context) => {
          const profile = profileFor(context);
          if (user.email !== undefined && user.email.toLowerCase() !== profile.email) throw new APIError('FORBIDDEN');
          return { data: { ...user, googleHostedDomain: profile.hostedDomain } };
        } },
      },
      account: {
        create: { before: async (account, context) => {
          const profile = profileFor(context);
          if (account.providerId !== 'google' || account.accountId !== profile.subject) throw new APIError('FORBIDDEN');
          return { data: { ...account, ...noTokens } };
        } },
        update: { before: async (account, context) => {
          profileFor(context);
          if (account.providerId !== undefined && account.providerId !== 'google') throw new APIError('FORBIDDEN');
          return { data: { ...account, ...noTokens } };
        } },
      },
      session: {
        create: { before: async (session, context) => {
          const profile = profileFor(context);
          if (runtime.config.multiTenant && profile.returning) await claimInvitation(runtime.db, session.userId, profile.email);
          if (!await isApprovedUser(runtime, session.userId)) throw new APIError('FORBIDDEN');
        } },
        update: { before: async (changes, context) => {
          if (!changes.expiresAt) return;
          // Better Auth renews during getSession, before the request's ordinary authorization check.
          const current = context?.context.session;
          if (!current || !await approvedUser(runtime, current.user.id, runtime.db, current.session)) throw new APIError('UNAUTHORIZED');
        } },
      },
    },
    logger: { disabled: true },
    // Returning from onError still lets better-call console.error the raw error
    // (including SQL parameters). Rethrow to our sanitized route boundaries;
    // better-call continues to serialize protocol APIErrors and redirects.
    onAPIError: { throw: true, errorURL: `${origin}/api/auth/error` },
  });
}

export function requireDashboardOrigin(runtime: Runtime, headers: Headers) {
  if (headers.get('origin') !== new URL(runtime.config.publicUrl).origin) {
    throw new ApiError(403, 'CSRF_ORIGIN_INVALID', 'This request must originate from the dashboard.');
  }
}
export async function invitationRecipient(runtime: Runtime, headers: Headers) {
  requireDashboardOrigin(runtime, headers);
  if (headers.has('authorization')) throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Accept invitations from a signed-in Google session.');
  const session = await createAuth(runtime).api.getSession({ headers, query: { disableRefresh: true } });
  const user = session && await approvedUser(runtime, session.user.id, runtime.db, session.session, false);
  if (!user || !session) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in with the invited Google account.');
  return { userId: session.user.id, email: user.email };
}
export async function getDashboardActor(runtime: Runtime, headers: Headers, measure: <T>(name: string, work: () => Promise<T>) => Promise<T> = async (_name, work) => work(), applyHeaders?: (headers: Headers) => void): Promise<Actor | null> {
  requireConfigured(runtime);
  try {
    // A check-only preflight must not consume a renewal without delivering its cookies to the browser.
    const result = await measure('session-db', () => createAuth(runtime).api.getSession({ headers, query: { disableRefresh: !applyHeaders }, returnHeaders: true }));
    applyHeaders?.(result.headers);
    const session = result.response;
    if (!session) return null;
    let principal: { workspaceId: string; role: string; email: string; name: string };
    if (runtime.config.multiTenant) {
      const wid = headers.get('x-opensend-workspace');
      const result = await measure('membership-db', () => runtime.db.execute<typeof principal>(sql`WITH member AS (
        SELECT m.workspace_id AS "workspaceId", m.role, u.email, u.name, u.id FROM auth_user u
        JOIN auth_session s ON s.user_id = u.id AND s.id = ${session.session.id} AND s.token = ${session.session.token} AND s.expires_at > now()
        JOIN auth_account g ON g.user_id = u.id AND g.provider_id = 'google' AND g.account_id <> ''
        JOIN workspace_members m ON m.user_id = u.id WHERE u.id = ${session.user.id} AND u.email_verified AND u.email <> ''
          AND m.role IN ('owner','admin','member') ${wid === null ? sql`` : sql`AND m.workspace_id = ${wid}`}
        ORDER BY (m.workspace_id = u.selected_workspace_id) DESC NULLS LAST, m.created_at, m.id LIMIT 1
      ) ${wid === null ? sql`` : sql`, selected AS (UPDATE auth_user u SET selected_workspace_id = member."workspaceId" FROM member WHERE u.id = member.id AND u.selected_workspace_id IS DISTINCT FROM member."workspaceId")`}
      SELECT "workspaceId", role, email, name FROM member`));
      if (!result.rows[0]) {
        if (wid !== null) throw new ApiError(403, 'WORKSPACE_ACCESS_DENIED', 'This workspace is not available to the current session.');
        return null;
      }
      principal = result.rows[0];
    } else {
      const user = await measure('approval-db', () => approvedUser(runtime, session.user.id, runtime.db, session.session));
      if (!user) return null;
      const owners = runtime.config.defaultWorkspaceOwners;
      const member = await membershipForApprovedUser(runtime.db, session.user.id, { bootstrapDefaultOwner: owners === '*' || owners.includes(user.email.toLowerCase()) });
      if (!member) return null;
      principal = { ...member, email: user.email, name: user.name };
    }
    return { keyId: `user_${session.user.id}`, ...principal, environment: 'live', permissions: principal.role === 'member' ? ['read', 'send'] : ['manage'], domains: [], credential: 'dashboard' };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof APIError && error.statusCode === 401) return null;
    log('warn', { operation: 'dashboard-session', code: 'AUTH_UNAVAILABLE' });
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'The sign-in service is temporarily unavailable.', undefined, true);
  }
}

// The dashboard exposes no password, profile-update, account-linking, or session
// JWT endpoints. The separate MCP allowlist owns only OAuth protocol endpoints.
const SignIn = z.object({ provider: z.literal('google'), callbackURL: z.string().optional(), newUserCallbackURL: z.string().optional(), errorCallbackURL: z.string().optional(), disableRedirect: z.boolean().optional() }).strict();
export function registerGoogleAuth(app: App) {
  app.on(['GET', 'POST', 'OPTIONS'], '/api/auth/*', async (c, next) => {
    const path = c.req.path.slice('/api/auth'.length);
    if (isMcpAuthPath(path)) return next();
    requireConfigured(c.env);
    c.header('Cache-Control', 'no-store');
    const method = c.req.method;
    if (path === '/error' && method === 'GET') return c.redirect(`${new URL(c.env.config.publicUrl).origin}/?auth=error`, 302);
    if (!((path === '/sign-in/social' && method === 'POST') || (path === '/callback/google' && method === 'GET') ||
      (path === '/get-session' && method === 'GET') || (path === '/sign-out' && method === 'POST'))) {
      throw new ApiError(404, 'NOT_FOUND', 'Authentication endpoint was not found.');
    }
    if (method === 'POST') requireDashboardOrigin(c.env, c.req.raw.headers);
    if (path === '/sign-in/social') {
      const input = SignIn.safeParse(await c.req.raw.clone().json().catch(() => null));
      if (!input.success) throw new ApiError(422, 'AUTH_INPUT_INVALID', 'Use Google browser sign-in without custom scopes or identity fields.');
    }
    if (path === '/get-session' && !await getDashboardActor(c.env, c.req.raw.headers, async (name, work) => timed(c, name, work))) return c.json(null);
    const started = performance.now();
    try {
      const result = await timed(c, 'auth-handler-db', () => createAuth(c.env).handler(c.req.raw));
      // Provider errors may contain arbitrary descriptions: never send them to a browser or log.
      const location = result.headers.get('location');
      if (location && new URL(location, c.env.config.publicUrl).searchParams.has('error')) {
        const headers = new Headers(result.headers);
        headers.set('location', `${new URL(c.env.config.publicUrl).origin}/?auth=error`);
        return new Response(null, { status: 302, headers });
      }
      if (result.status >= 400) throw new ApiError(result.status, 'AUTH_FAILED', 'Google sign-in failed. Please try again.');
      if (path === '/callback/google') log('info', { requestId: c.get('requestId'), operation: 'google-oauth-callback', status: 'success', durationMs: Number((performance.now() - started).toFixed(1)) });
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      log('warn', { operation: 'google-auth', code: 'AUTH_FAILED' });
      throw new ApiError(503, 'AUTH_FAILED', 'Google sign-in failed. Please try again.');
    }
  });
  app.openapi(createRoute({ method: 'get', path: '/v1/me', operationId: 'getCurrentIdentity', tags: ['Auth'], security,
    responses: { 200: response(z.object({ id: z.string(), workspaceId: z.string(), role: WorkspaceRole.nullable(), multiTenant: z.boolean(), simulated: z.boolean(), email: z.string().nullable(), name: z.string().nullable(), permissions: z.array(z.enum(['read', 'send', 'manage'])), domains: z.array(z.string()), origin: z.string().url(), host: z.string(), connection: ConnectionSummary.nullable().openapi({ description: 'Multi-tenant sending connection for the current workspace, or null (always null when self-hosted).' }) })), ...errors },
  }), async c => {
    const identity = c.get('actor');
    const userId = identity.keyId.startsWith('user_') ? identity.keyId.slice(5) : null;
    const origin = new URL(c.env.config.publicUrl).origin;
    return c.json({ id: userId ?? identity.keyId, workspaceId: identity.workspaceId, role: WorkspaceRole.nullable().parse(identity.role ?? null), multiTenant: c.env.config.multiTenant, simulated: isSimulatedSes(c.env), email: identity.email ?? null, name: identity.name ?? null, permissions: identity.permissions, domains: identity.domains, origin, host: new URL(origin).host, connection: c.env.config.multiTenant ? await connectionSummary(c.env, identity.workspaceId) : null }, 200);
  });
}
