import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export type Env = {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  HYPERDRIVE: Hyperdrive;
  /** This Worker's origin, e.g. https://opcd.ai. */
  PUBLIC_URL: string;
  OPENSEND_URL: string;
  /** Parent mail domain; organizations receive at <slug>.<MAIL_DOMAIN>. */
  MAIL_DOMAIN: string;
  /** Sender of invitation emails, on MAIL_DOMAIN. */
  INVITE_FROM: string;
  /** Who may create organizations: comma-separated emails or @domains. Empty allows anyone. Invited people can always join. */
  SIGNUP_ALLOWLIST: string;
  // Secrets
  OPENSEND_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
};

export const origin = (env: Env) => new URL(env.PUBLIC_URL).origin;

export function mayCreateOrganizations(env: Env, email: string) {
  const entries = env.SIGNUP_ALLOWLIST.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return true;
  const lower = email.toLowerCase();
  return entries.some(entry => entry.startsWith('@') ? lower.endsWith(entry) : lower === entry);
}
