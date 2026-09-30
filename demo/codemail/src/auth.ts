import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { CodemailProps } from './mcp.js';

export type Env = { OAUTH_KV: KVNamespace; OAUTH_PROVIDER: OAuthHelpers; OPENSEND_URL: string; PUBLIC_URL: string };

const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const KEY = /^os_mbx_[0-9a-f]{64}$/;

const STYLE = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px 16px;background:#f6f6f4;color:#191919;font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
main{width:100%;max-width:520px;background:#fff;border:1px solid #e6e6e2;border-radius:14px;padding:32px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;font-weight:600;letter-spacing:-.01em}.brand i{width:14px;height:14px;border-radius:4px;background:#3d5afe;display:inline-block}
h1{margin:0 0 8px;font-size:21px;line-height:1.3;letter-spacing:-.015em}p{margin:0 0 16px;color:#555}.muted{color:#777;font-size:13px}
label{display:block;margin:20px 0 6px;font-weight:500;font-size:14px}input[type=password]{width:100%;height:40px;padding:0 12px;border:1px solid #d9d9d4;border-radius:8px;font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
input:focus{outline:2px solid #3d5afe;outline-offset:1px;border-color:transparent}
.facts{margin:16px 0;padding:12px 14px;border-radius:10px;background:#f6f6f4;font-size:13px}.facts div{display:flex;justify-content:space-between;gap:16px;padding:3px 0}.facts span:first-child{color:#777}
.warn{margin:12px 0;padding:10px 14px;border-radius:10px;background:#fff7e6;border:1px solid #f5d69a;color:#6b4a00;font-size:13px}.error{margin:12px 0;padding:10px 14px;border-radius:10px;background:#fdecec;border:1px solid #f3b9b9;color:#8a1c1c;font-size:13px}
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}button{height:38px;padding:0 16px;border-radius:8px;border:1px solid #d9d9d4;background:#fff;font:inherit;font-weight:500;cursor:pointer}button.primary{background:#191919;border-color:#191919;color:#fff}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f1f1ee;padding:2px 6px;border-radius:5px}ol{padding-left:20px;margin:0 0 16px;color:#555}li{margin:6px 0}a{color:#3d5afe}`;

function page(title: string, body: string, status = 200, extra?: Headers) {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style><main><div class="brand"><i></i>codemail</div>${body}</main></html>`, { status, headers });
}

function landing(env: Env) {
  const mcp = `${env.PUBLIC_URL.replace(/\/$/, '')}/mcp`;
  return page('codemail', `<h1>Email for AI agents</h1>
<p>codemail is an MCP server that gives an agent a real mailbox: read conversations, reply in-thread, send, forward, organize, and wait for new mail.</p>
<ol><li>Create a <strong>mailbox key</strong> in OpenSend under <a href="${escape(env.OPENSEND_URL)}/api-keys">API keys → Mailbox keys</a>.</li>
<li>Add this MCP server to your client: <code>${escape(mcp)}</code></li>
<li>Sign in when prompted and paste the mailbox key.</li></ol>
<p class="muted">The key is stored encrypted inside your OAuth grant and is only used to call the OpenSend mailbox API.</p>`);
}

function consentPage(details: ConsentDescription, handle: string, env: Env, error?: string) {
  const name = escape(details.clientName);
  const origin = details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'This app registered itself, so its name is not verified.';
  return `<h1>Connect ${name} to a mailbox</h1>
<p>${origin} It will be able to read, send and organize mail in the mailboxes your key allows.</p>
<div class="facts"><div><span>App</span><span>${name}</span></div><div><span>Access goes to</span><strong>${escape(details.redirectHost)}</strong></div></div>
${details.redirectIsLoopback ? '<div class="warn">Access is sent to an app on your computer. Continue only if you just started connecting from it.</div>' : ''}
${error ? `<div class="error">${escape(error)}</div>` : ''}
<form method="post" autocomplete="off">
<input type="hidden" name="handle" value="${escape(handle)}">
<label for="key">OpenSend mailbox key</label>
<input id="key" name="key" type="password" placeholder="os_mbx_…" spellcheck="false" autofocus>
<p class="muted" style="margin-top:8px">Create one in OpenSend under <a href="${escape(env.OPENSEND_URL)}/api-keys" target="_blank" rel="noreferrer">API keys → Mailbox keys</a>. Its mailbox scope and permissions limit what the app can do.</p>
<div class="actions"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Connect mailbox</button></div>
</form>`;
}

async function keyPrefixHash(key: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(digest.slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Checks a mailbox key against OpenSend and returns the mailboxes it can use. */
async function verifyKey(env: Env, key: string): Promise<{ id: string; address: string }[] | string> {
  if (!KEY.test(key)) return 'That is not a mailbox key. It starts with os_mbx_ followed by 64 characters.';
  let response: Response;
  try { response = await fetch(`${env.OPENSEND_URL.replace(/\/$/, '')}/mailbox/v1/mailboxes?limit=100`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }); }
  catch { return 'OpenSend could not be reached. Try again in a moment.'; }
  if (response.status === 401) return 'OpenSend did not accept this key. It may be revoked or mistyped.';
  if (response.status === 403) return 'This key cannot read mailboxes. Create a mailbox key with the read permission.';
  if (!response.ok) return `OpenSend returned an error (HTTP ${response.status}). Try again in a moment.`;
  const body = await response.json() as { data: { id: string; address: string }[] };
  if (!body.data.length) return 'This key has no mailboxes. Scope it to at least one mailbox in OpenSend.';
  return body.data.map(({ id, address }) => ({ id, address }));
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return landing(env);
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === 'GET') {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return page(`Connect ${details.clientName}`, consentPage(details, consent.handle, env), 200, consent.headers);
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const key = String(form.get('key') ?? '').trim();
      const mailboxes = await verifyKey(env, key);
      if (typeof mailboxes === 'string') {
        // The handle is still unused, so the same consent page can be shown again with the error.
        return page('Connect mailbox', `<h1>Connect a mailbox</h1><div class="error">${escape(mailboxes)}</div>
<form method="post" autocomplete="off"><input type="hidden" name="handle" value="${escape(handle)}"><label for="key">OpenSend mailbox key</label><input id="key" name="key" type="password" placeholder="os_mbx_…" spellcheck="false" autofocus>
<div class="actions"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Connect mailbox</button></div></form>`, 400);
      }
      const approved = await oauth.approveConsent(request, handle, { scope: ['mail'] });
      const userId = `key-${await keyPrefixHash(key)}`;
      const props: CodemailProps = { mailboxKey: key, keyPrefix: key.slice(0, 14), mailboxes };
      const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId, metadata: { label: mailboxes.map(m => m.address).join(', ') }, scope: approved.request.scope.length ? approved.request.scope : ['mail'], props });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
        return page('Sign-in problem', `<h1>Something went wrong</h1><div class="error">${escape(message)}</div><p>Start connecting again from your MCP client.</p>`, 400);
      }
      throw error;
    }
  },
};
