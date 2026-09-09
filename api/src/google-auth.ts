import { createRoute, z } from '@hono/zod-openapi';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { google, verifyGoogleIdToken } from 'better-auth/social-providers';
import { jwt } from 'better-auth/plugins';
import { createMcpPlugin, isMcpAuthPath } from './mcp-auth.js';
import { mcpAuthSchema } from './db/mcp-auth.js';
import { and, eq, ne } from 'drizzle-orm';
import { ApiError, errors, log, response, security, timed } from './core.js';
import type { Actor, App, DbExecutor, Mode, Runtime } from './core.js';
import { authAccount, authUser, googleAuthSchema } from './db/google-auth.js';

function configured(runtime: Runtime) {
  return Boolean(runtime.config.googleClientId && runtime.config.googleClientSecret && runtime.config.authSecret);
}
function requireConfigured(runtime: Runtime) {
  if (!configured(runtime)) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Google sign-in is not configured for this deployment.');
}
function approved(runtime: Runtime, email: unknown, emailVerified: unknown, hostedDomain: unknown) {
  if (emailVerified !== true || typeof email !== 'string' || !email) return false;
  return runtime.config.allowedEmails.includes(email.toLowerCase()) ||
    (typeof hostedDomain === 'string' && hostedDomain !== '' && runtime.config.allowedDomains.includes(hostedDomain.toLowerCase()));
}

export async function isApprovedUser(runtime: Runtime, userId: string, db: DbExecutor = runtime.db): Promise<boolean> {
  if (!configured(runtime)) return false;
  const [user] = await db.select({ email: authUser.email, emailVerified: authUser.emailVerified, googleHostedDomain: authUser.googleHostedDomain })
    .from(authUser).innerJoin(authAccount, and(eq(authAccount.userId, authUser.id), eq(authAccount.providerId, 'google'), ne(authAccount.accountId, '')))
    .where(eq(authUser.id, userId)).limit(1).for('share');
  // With a transaction executor, hold the approved user/account through dispatch's claim.
  return Boolean(user && approved(runtime, user.email, user.emailVerified, user.googleHostedDomain));
}

// Called per runtime/request: never retain a Workers connection in a module-global auth instance.
export function createAuth(runtime: Runtime) {
  requireConfigured(runtime);
  const origin = new URL(runtime.config.publicUrl).origin;
  const secure = origin.startsWith('https:');
  const googleProvider = google({ clientId: runtime.config.googleClientId!, clientSecret: runtime.config.googleClientSecret! });
  // Better Auth intentionally drops input:false fields from mapProfileToUser. Only
  // its verified OAuth lifecycle gate can supply this protected database field.
  const profiles = new WeakMap<object, { email: string; subject: string; hostedDomain: string | null }>();
  const profileFor = (context: object | null) => {
    const profile = context && profiles.get(context);
    if (!profile) throw new APIError('FORBIDDEN', { code: 'GOOGLE_IDENTITY_REQUIRED', message: 'An approved Google identity is required.' });
    return profile;
  };
  const noTokens = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, scope: null, password: null };
  return betterAuth({
    appName: 'OpenSend', baseURL: origin, basePath: '/api/auth', secret: runtime.config.authSecret,
    database: drizzleAdapter(runtime.db, { provider: 'pg', schema: { ...googleAuthSchema, ...mcpAuthSchema }, transaction: true }),
    plugins: [jwt({ disableSettingJwtHeader: true, jwt: { issuer: `${origin}/api/auth` }, jwks: { keyPairConfig: { alg: 'ES256' } } }), createMcpPlugin(runtime)],
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
          !approved(runtime, profile.email, profile.email_verified, profile.hd)) {
          return { error: 'GOOGLE_ACCESS_DENIED', errorDescription: 'This Google identity is not approved.' };
        }
        profiles.set(context, { email: profile.email.toLowerCase(), subject: profile.sub, hostedDomain: typeof profile.hd === 'string' ? profile.hd.toLowerCase() : null });
      },
    },
    session: { expiresIn: 8 * 60 * 60, disableSessionRefresh: true, cookieCache: { enabled: false } },
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
      session: { create: { before: async (session, context) => {
        profileFor(context);
        if (!await isApprovedUser(runtime, session.userId)) throw new APIError('FORBIDDEN');
      } } },
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
export async function getDashboardActor(runtime: Runtime, headers: Headers, mode?: Mode, measure: <T>(name: string, work: () => Promise<T>) => Promise<T> = async (_name, work) => work()): Promise<Actor | null> {
  requireConfigured(runtime);
  try {
    const session = await measure('session-db', () => createAuth(runtime).api.getSession({ headers }));
    if (!session || !await measure('approval-db', () => isApprovedUser(runtime, session.user.id))) return null;
    const selected = headers.get('x-opensend-environment');
    if (selected !== null && selected !== 'test' && selected !== 'live') throw new ApiError(422, 'ENVIRONMENT_INVALID', 'Select live or test with X-OpenSend-Environment.', 'X-OpenSend-Environment');
    return { keyId: `user_${session.user.id}`, workspaceId: runtime.config.workspaceId, environment: mode ?? selected ?? 'live', permissions: ['manage'], domains: [] };
  } catch (error) {
    if (error instanceof ApiError) throw error;
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
    if (path === '/get-session' && !await getDashboardActor(c.env, c.req.raw.headers, undefined, async (name, work) => timed(c, name, work))) return c.json(null);
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
    responses: { 200: response(z.object({ id: z.string(), email: z.string().nullable(), name: z.string().nullable(), environment: z.enum(['live', 'test']), permissions: z.array(z.enum(['read', 'send', 'manage'])) })), ...errors },
  }), async c => {
    const identity = c.get('actor');
    const userId = identity.keyId.startsWith('user_') ? identity.keyId.slice(5) : null;
    const [user] = userId ? await c.env.db.select({ email: authUser.email, name: authUser.name }).from(authUser).where(eq(authUser.id, userId)).limit(1) : [];
    return c.json({ id: userId ?? identity.keyId, email: user?.email ?? null, name: user?.name ?? null, environment: identity.environment, permissions: identity.permissions }, 200);
  });
}
