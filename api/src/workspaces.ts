import { createRoute, z } from '@hono/zod-openapi';
import { and, eq, sql } from 'drizzle-orm';
import { ApiError, errors, id, IdParams, json, notFound, response, type App, type Ctx, type DbExecutor } from './core.js';
import { authUser } from './db/google-auth.js';
import { workspaceMembers, workspaces } from './db/workspaces.js';
import { invitationRecipient } from './google-auth.js';

export const WorkspaceRole = z.enum(['owner', 'admin', 'member']);
type Role = z.infer<typeof WorkspaceRole>;
const Workspace = z.object({ id: z.string(), name: z.string(), slug: z.string(), role: WorkspaceRole }).openapi('Workspace');
const Member = z.object({ id: z.string(), userId: z.string(), email: z.string(), name: z.string(), role: WorkspaceRole }).openapi('WorkspaceMember');
const Invitation = z.object({ id: z.string(), workspaceId: z.string(), email: z.string(), role: WorkspaceRole, expiresAt: z.string(), acceptUrl: z.string().url() }).openapi('WorkspaceInvitation');
const Invite = z.object({ email: z.email().toLowerCase(), role: WorkspaceRole }).strict().openapi('InviteWorkspaceMember');
const Removed = z.object({ id: z.string(), deleted: z.literal(true) });
const security: Record<string, string[]>[] = [{ dashboardSession: [] }, { secureDashboardSession: [] }];
const tags = ['Workspaces'];
const base = '/v1/workspaces/current';

// Accept one invitation, deterministically if several workspaces invited this address. Never
// overwrite an existing membership's role. The invite claim and membership are one statement.
export async function claimInvitation(db: DbExecutor, userId: string, email: string, invitationId?: string) {
  const result = await db.execute<{ workspace_id: string }>(sql`WITH pending AS (
    SELECT i.id FROM workspace_invitations i JOIN workspace_members inviter ON inviter.workspace_id = i.workspace_id AND inviter.user_id = i.inviter_id
    WHERE i.email = ${email.toLowerCase()} AND i.status = 'pending' AND i.expires_at > now() AND i.role IN ('owner','admin','member')
      AND (inviter.role = 'owner' OR (inviter.role = 'admin' AND i.role <> 'owner'))
      ${invitationId === undefined ? sql`AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = ${userId})` : sql`AND i.id = ${invitationId}`}
    ORDER BY i.created_at, i.id LIMIT 1 FOR UPDATE OF i FOR SHARE OF inviter
  ), claimed AS (
    UPDATE workspace_invitations i SET status = 'accepted' FROM pending WHERE i.id = pending.id RETURNING i.workspace_id, i.role
  ), joined AS (
    INSERT INTO workspace_members (id, workspace_id, user_id, role) SELECT ${id('mem')}, workspace_id, ${userId}, role FROM claimed
    ON CONFLICT (workspace_id, user_id) DO NOTHING
  ) UPDATE auth_user u SET selected_workspace_id = claimed.workspace_id FROM claimed WHERE u.id = ${userId} RETURNING claimed.workspace_id`);
  return result.rows[0]?.workspace_id;
}

// Called only in the transaction that *inserts* the Google user. Ordinary dashboard requests,
// refreshes and dispatch cannot bootstrap a removed member or create a second organization.
export async function onboardNewUser(db: DbExecutor, user: { id: string; name: string; email: string }, allowSignup: boolean, region: string) {
  if (await claimInvitation(db, user.id, user.email)) return true;
  if (!allowSignup) return false;
  const workspaceId = id('ws'), name = `${(user.name.trim() || user.email.split('@')[0]!).slice(0, 105)}'s Organization`;
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}-${workspaceId.slice(3)}`;
  await db.execute(sql`WITH created AS (
    INSERT INTO workspaces(id, name, slug) VALUES (${workspaceId}, ${name}, ${slug}) RETURNING id
  ), region_settings AS (
    INSERT INTO ses_installation_settings(workspace_id, installation_id, default_region, enabled_regions)
    SELECT id, ${id('install')}, ${region}, ${JSON.stringify([region])}::jsonb FROM created
  ) INSERT INTO workspace_members(id, workspace_id, user_id, role) SELECT ${id('mem')}, id, ${user.id}, 'owner' FROM created`);
  return true;
}

function dashboard(c: Ctx, manage = false) {
  if (!c.env.config.multiTenant) return notFound('Endpoint');
  const a = c.get('actor');
  if (a.credential !== 'dashboard') throw new ApiError(403, 'DASHBOARD_AUTH_REQUIRED', 'Use a signed-in dashboard session.');
  if (manage && a.role !== 'admin' && a.role !== 'owner') throw new ApiError(403, 'PERMISSION_DENIED', 'Workspace administration requires an owner or admin.');
  return { workspaceId: a.workspaceId, userId: a.keyId.slice(5), email: a.email! };
}

// Serialize governance writes per workspace. Read the caller and owner count *after* locking:
// concurrent demotions cannot authorize each other on an old snapshot or remove both owners.
function administer<T>(c: Ctx, action: (db: DbExecutor, workspaceId: string, userId: string, role: 'owner' | 'admin') => Promise<T>) {
  const { workspaceId, userId } = dashboard(c, true);
  return c.env.db.transaction(async db => {
    await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('no key update');
    const [member] = await db.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (member?.role !== 'owner' && member?.role !== 'admin') throw new ApiError(403, 'PERMISSION_DENIED', 'Workspace administration requires an owner or admin.');
    return action(db, workspaceId, userId, member.role);
  });
}
const ownerRequired = () => new ApiError(403, 'OWNER_REQUIRED', 'Only an owner can change workspace ownership.');
function changeMember(c: Ctx, memberId: string, newRole?: Role) {
  return administer(c, async (db, wid, _uid, role) => {
    const filter = and(eq(workspaceMembers.workspaceId, wid), eq(workspaceMembers.id, memberId));
    const [member] = await db.select({ role: workspaceMembers.role, otherOwner: sql<boolean>`EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = ${wid} AND role = 'owner' AND id <> ${memberId})` }).from(workspaceMembers).where(filter);
    if (!member) return notFound('Member');
    if ((member.role === 'owner' || newRole === 'owner') && role !== 'owner') throw ownerRequired();
    if (member.role === 'owner' && newRole !== 'owner' && !member.otherOwner) throw new ApiError(409, 'LAST_OWNER', 'Promote another owner before removing or demoting the last owner.');
    if (newRole) await db.update(workspaceMembers).set({ role: newRole }).where(filter);
    else await db.delete(workspaceMembers).where(filter);
  });
}
type InviteRow = { id: string; workspaceId: string; email: string; role: Role; expiresAt: Date };
function invitationView(c: Ctx, row: InviteRow) {
  return { ...row, expiresAt: new Date(row.expiresAt).toISOString(), acceptUrl: `${c.env.config.publicUrl}/?invitation=${encodeURIComponent(row.id)}` };
}
async function invite(c: Ctx, input: z.infer<typeof Invite>) {
  return administer(c, async (db, wid, uid, role) => {
    if (input.role === 'owner' && role !== 'owner') throw ownerRequired();
    const result = await db.execute<InviteRow>(sql`INSERT INTO workspace_invitations(id, workspace_id, email, role, inviter_id, expires_at)
      SELECT ${id('inv')}, ${wid}, ${input.email}, ${input.role}, ${uid}, now() + interval '7 days'
      WHERE NOT EXISTS(SELECT 1 FROM workspace_members m JOIN auth_user u ON u.id = m.user_id WHERE m.workspace_id = ${wid} AND lower(u.email) = ${input.email})
      ON CONFLICT (workspace_id, email) WHERE status = 'pending' DO UPDATE SET id = excluded.id, role = excluded.role, inviter_id = excluded.inviter_id, expires_at = excluded.expires_at, created_at = now()
      WHERE workspace_invitations.expires_at <= now()
      RETURNING id, workspace_id AS "workspaceId", email, role, expires_at AS "expiresAt"`);
    if (!result.rows[0]) throw new ApiError(409, 'ALREADY_INVITED_OR_MEMBER', 'This address already has a pending invitation or membership.');
    return invitationView(c, result.rows[0]);
  });
}

export function registerWorkspaces(app: App) {
  app.openapi(createRoute({ method: 'get', path: '/v1/workspaces', operationId: 'listWorkspaces', tags, security,
    description: 'Lists your memberships. Dashboard requests can select a membership with X-OpenSend-Workspace (workspace ID); without it, the most recent selection is used. Workspace administration requires a Google session.',
    responses: { 200: response(z.object({ data: z.array(Workspace) })), ...errors } }), async c => {
    const a = dashboard(c);
    const rows = await c.env.db.select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, role: workspaceMembers.role }).from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId)).where(eq(workspaceMembers.userId, a.userId)).orderBy(workspaces.name, workspaces.id);
    return c.json({ data: rows.map(row => Workspace.parse(row)) }, 200);
  });
  app.openapi(createRoute({ method: 'patch', path: base, operationId: 'renameCurrentWorkspace', tags, security, request: { body: json(z.object({ name: z.string().trim().min(1).max(120) }).strict()) }, responses: { 200: response(Workspace), ...errors } }), async c => {
    const { name } = c.req.valid('json');
    const row = await administer(c, async (db, wid, _uid, role) => {
      const [w] = await db.update(workspaces).set({ name }).where(eq(workspaces.id, wid)).returning({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug });
      return { ...w!, role };
    });
    return c.json(row, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/members`, operationId: 'listWorkspaceMembers', tags, security, responses: { 200: response(z.object({ data: z.array(Member) })), ...errors } }), async c => {
    const a = dashboard(c, true);
    const rows = await c.env.db.select({ id: workspaceMembers.id, userId: authUser.id, role: workspaceMembers.role, email: authUser.email, name: authUser.name }).from(workspaceMembers).innerJoin(authUser, eq(authUser.id, workspaceMembers.userId)).where(eq(workspaceMembers.workspaceId, a.workspaceId)).orderBy(authUser.email);
    return c.json({ data: rows.map(row => Member.parse(row)) }, 200);
  });
  for (const [resource, operationId] of [['members', 'inviteWorkspaceMember'], ['invitations', 'createWorkspaceInvitation']] as const) {
    app.openapi(createRoute({ method: 'post', path: `${base}/${resource}` as const, operationId, description: 'Invite an email address. Membership starts only after acceptance by the verified address. Share the returned URL; no email is sent.', tags, security, request: { body: json(Invite) }, responses: { 201: response(Invitation), ...errors } }), async c => c.json(await invite(c, c.req.valid('json')), 201));
  }
  app.openapi(createRoute({ method: 'patch', path: `${base}/members/{id}`, operationId: 'updateWorkspaceMember', tags, security, request: { params: IdParams, body: json(z.object({ role: WorkspaceRole }).strict()) }, responses: { 200: response(z.object({ id: z.string(), role: WorkspaceRole })), ...errors } }), async c => {
    const { id } = c.req.valid('param'), { role } = c.req.valid('json'); await changeMember(c, id, role); return c.json({ id, role }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${base}/members/{id}`, operationId: 'removeWorkspaceMember', tags, security, request: { params: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const { id } = c.req.valid('param'); await changeMember(c, id); return c.json({ id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'get', path: `${base}/invitations`, operationId: 'listWorkspaceInvitations', tags, security, description: 'List pending, unexpired workspace invitations.', responses: { 200: response(z.object({ data: z.array(Invitation) })), ...errors } }), async c => {
    const a = dashboard(c, true);
    const result = await c.env.db.execute<InviteRow>(sql`SELECT id, workspace_id AS "workspaceId", email, role, expires_at AS "expiresAt" FROM workspace_invitations WHERE workspace_id = ${a.workspaceId} AND status = 'pending' AND expires_at > now() ORDER BY email`);
    return c.json({ data: result.rows.map(row => invitationView(c, row)) }, 200);
  });
  app.openapi(createRoute({ method: 'delete', path: `${base}/invitations`, operationId: 'revokeWorkspaceInvitation', tags, security, request: { query: IdParams }, responses: { 200: response(Removed), ...errors } }), async c => {
    const { id } = c.req.valid('query');
    await administer(c, async (db, wid, _uid, role) => {
      const result = await db.execute(sql`UPDATE workspace_invitations SET status = 'canceled' WHERE id = ${id} AND workspace_id = ${wid} AND status = 'pending' AND (role <> 'owner' OR ${role} = 'owner') RETURNING id`);
      if (!result.rowCount) notFound('Invitation');
    });
    return c.json({ id, deleted: true as const }, 200);
  });
  app.openapi(createRoute({ method: 'post', path: '/v1/workspaces/invitations/{id}/accept', operationId: 'acceptWorkspaceInvitation', tags, security, request: { params: IdParams }, responses: { 200: response(z.object({ workspaceId: z.string() })), ...errors } }), async c => {
    if (!c.env.config.multiTenant) return notFound('Endpoint');
    const a = await invitationRecipient(c.env, c.req.raw.headers), invitationId = c.req.valid('param').id;
    const workspaceId = await claimInvitation(c.env.db, a.userId, a.email, invitationId);
    if (workspaceId) return c.json({ workspaceId }, 200);
    // Following the URL immediately after sign-in is an idempotent success, never a rejoin.
    const existing = await c.env.db.execute<{ workspace_id: string }>(sql`SELECT i.workspace_id FROM workspace_invitations i JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = ${a.userId} WHERE i.id = ${invitationId} AND i.email = ${a.email.toLowerCase()} AND i.status = 'accepted'`);
    return c.json({ workspaceId: existing.rows[0]?.workspace_id ?? notFound('Invitation') }, 200);
  });
}
