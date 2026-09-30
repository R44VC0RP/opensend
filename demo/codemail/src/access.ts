// Mailbox permissions. A personal mailbox is readable only by its owner (not even org admins). A shared
// mailbox is readable by its managers and members; managers and org admins decide who's on it.
import { and, eq, inArray } from 'drizzle-orm';
import { mailboxAccess, member, type Db } from './db.js';
import type { Mailbox, OpenSendAdmin } from './opensend.js';

export type Role = 'owner' | 'manager' | 'member';
export type MailboxEntry = { mailbox: Mailbox; role: Role | null; personalFor: string | null };

export const personalOwner = (mailbox: Mailbox) => typeof mailbox.metadata?.personalFor === 'string' ? mailbox.metadata.personalFor : null;
const creator = (mailbox: Mailbox) => typeof mailbox.metadata?.createdBy === 'string' ? mailbox.metadata.createdBy : null;
export const isOrgAdmin = (orgRole: string) => orgRole === 'owner' || orgRole === 'admin';
/** Who may change a mailbox's access list: its managers and org admins, and never for a personal mailbox. */
export const canManage = (entry: MailboxEntry, orgRole: string) => !entry.personalFor && (entry.role === 'manager' || isOrgAdmin(orgRole));
/** Deleting: org admins (any mailbox, without reading it) and a shared mailbox's managers. */
export const canDelete = (entry: MailboxEntry, orgRole: string) => isOrgAdmin(orgRole) || (!entry.personalFor && entry.role === 'manager');

/**
 * Gives mailboxes that have no access rows yet their first rows: a personal mailbox's owner, or a shared
 * mailbox's creator as manager (the org owner when the creator is unknown or has left). Only current
 * members get rows, so a departed member's personal mailbox stays unreadable.
 */
async function backfill(db: Db, orgId: string, mailboxes: Mailbox[], have: Set<string>) {
  const missing = mailboxes.filter(mailbox => !have.has(mailbox.id));
  if (!missing.length) return [];
  const members = await db.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.organizationId, orgId));
  const current = new Set(members.map(row => row.userId));
  const owners = members.filter(row => row.role === 'owner').map(row => row.userId);
  type Row = { mailboxId: string; organizationId: string; userId: string; role: Role };
  const rows = missing.flatMap((mailbox): Row[] => {
    const personal = personalOwner(mailbox);
    if (personal) return current.has(personal) ? [{ mailboxId: mailbox.id, organizationId: orgId, userId: personal, role: 'owner' }] : [];
    const made = creator(mailbox);
    return (made && current.has(made) ? [made] : owners).map(userId => ({ mailboxId: mailbox.id, organizationId: orgId, userId, role: 'manager' }));
  });
  if (rows.length) await db.insert(mailboxAccess).values(rows).onConflictDoNothing();
  return rows;
}

/** Every mailbox in the organization, with the viewer's role on each (null = no access). */
export async function mailboxesFor(db: Db, admin: OpenSendAdmin, org: { id: string }, host: string, userId: string): Promise<MailboxEntry[]> {
  const mailboxes = await admin.mailboxes(host);
  const rows = await db.select().from(mailboxAccess).where(eq(mailboxAccess.organizationId, org.id));
  const added = await backfill(db, org.id, mailboxes, new Set(rows.map(row => row.mailboxId)));
  const all = [...rows, ...added];
  return mailboxes.map(mailbox => ({ mailbox, personalFor: personalOwner(mailbox), role: all.find(row => row.mailboxId === mailbox.id && row.userId === userId)?.role ?? null }));
}

/** The people on one mailbox. */
export async function accessList(db: Db, mailboxId: string) {
  return db.select().from(mailboxAccess).where(eq(mailboxAccess.mailboxId, mailboxId));
}

export async function grantAccess(db: Db, input: { mailboxId: string; organizationId: string; userId: string; role: Role; addedBy?: string }) {
  await db.insert(mailboxAccess).values({ ...input, addedBy: input.addedBy ?? null })
    .onConflictDoUpdate({ target: [mailboxAccess.mailboxId, mailboxAccess.userId], set: { role: input.role } });
}
export async function removeAccess(db: Db, mailboxId: string, userId?: string) {
  await db.delete(mailboxAccess).where(userId ? and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.userId, userId)) : eq(mailboxAccess.mailboxId, mailboxId));
}
export async function removeMemberAccess(db: Db, orgId: string, userId: string) {
  await db.delete(mailboxAccess).where(and(eq(mailboxAccess.organizationId, orgId), eq(mailboxAccess.userId, userId)));
}
/** The subset of mailboxIds the user may read. */
export async function readable(db: Db, userId: string, mailboxIds: string[]) {
  if (!mailboxIds.length) return new Set<string>();
  const rows = await db.select({ id: mailboxAccess.mailboxId }).from(mailboxAccess).where(and(eq(mailboxAccess.userId, userId), inArray(mailboxAccess.mailboxId, mailboxIds)));
  return new Set(rows.map(row => row.id));
}
