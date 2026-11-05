import { useState, type FormEvent } from 'react'
import { Button, ConfirmDialog, ControlSkeleton, CopyButton, DataTable, Dialog, EmptyState, ErrorState, Field, FieldSkeleton, Input, SectionHeader, Select } from '../../components/ui'
import { useApiMutation, useApiDef, useSession, useWorkspaceAccess } from '../../data/context'
import { queries } from '../../data/queries'
import type { WorkspaceInvitation, WorkspaceMember, WorkspaceRole } from '../../data/types'
import { roleLabel, workspaceApi } from '../../data/workspaces'
import { date } from '../../lib/format'
import { fieldError, MutationError } from './shared'

const roleOptions = (owner: boolean) => (owner ? ['owner', 'admin', 'member'] as const : ['admin', 'member'] as const).map(role => ({ value: role, label: roleLabel[role] }))

function WorkspaceName({ canEdit }: { canEdit: boolean }) {
  const session = useSession()
  const workspaces = useApiDef(queries.workspaces())
  const current = workspaces.data?.find(workspace => workspace.id === session?.identity?.workspaceId)
  return <section id="workspace" className={`section stack settings-group${canEdit ? ' settings-rule' : ''}`}>
    {workspaces.error ? <><SectionHeader title="Workspace" /><ErrorState error={workspaces.error} onRetry={() => void workspaces.refetch()} /></> : !current ? <div className="stack"><SectionHeader title="Workspace" actions={canEdit && <ControlSkeleton width={58} />} /><FieldSkeleton label="Name" /></div> : <WorkspaceNameForm key={current.id} name={current.name} canEdit={canEdit} />}
  </section>
}
function WorkspaceNameForm({ name: initial, canEdit }: { name: string; canEdit: boolean }) {
  const [name, setName] = useState(initial)
  const save = useApiMutation((_api, value: string) => workspaceApi.rename(value), 'Saved')
  async function submit(event: FormEvent) { event.preventDefault(); try { await save.mutateAsync(name.trim()) } catch { /* inline */ } }
  return <form className="stack" onSubmit={submit}>
    <SectionHeader title="Workspace" actions={canEdit && <Button type="submit" loading={save.isPending} disabled={!name.trim() || name.trim() === initial} variant="primary">Save</Button>} />
    <MutationError error={save.error} />
    <Field label="Name" htmlFor="workspace-name" error={fieldError(save.error, 'name')} hint={canEdit ? undefined : 'Only owners and admins can rename the workspace.'}><Input id="workspace-name" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={save.isPending} readOnly={!canEdit} required /></Field>
  </form>
}

function Members({ owner, onInvite }: { owner: boolean; onInvite: () => void }) {
  const session = useSession()
  const members = useApiDef(queries.workspaceMembers())
  const update = useApiMutation((_api, input: { id: string; role: WorkspaceRole }) => workspaceApi.updateMember(input.id, input.role), 'Role updated')
  const remove = useApiMutation((_api, id: string) => workspaceApi.removeMember(id), 'Member removed')
  const [removing, setRemoving] = useState<WorkspaceMember | null>(null)
  const owners = members.data?.filter(member => member.role === 'owner').length ?? 0
  // Only owners manage owners; the last owner stays until another is promoted. Your own row is read-only.
  const manageable = (member: WorkspaceMember) => member.userId !== session?.identity?.id && (owner || member.role !== 'owner')
  const lastOwner = (member: WorkspaceMember) => member.role === 'owner' && owners <= 1
  return <section className="section stack settings-rule">
    <SectionHeader title="Members" actions={<Button onClick={onInvite}>Invite teammate</Button>} />
    <MutationError error={update.error} />
    {members.error ? <ErrorState error={members.error} onRetry={() => void members.refetch()} /> : <DataTable loading={members.isPending} skeletonRows={2} rows={members.data ?? []} rowKey={member => member.id} empty={<EmptyState title="No members" />} columns={[
      { key: 'name', label: 'Name', width: '28%', render: member => <>{member.name || '—'}{member.userId === session?.identity?.id && <span className="muted"> · You</span>}</> },
      { key: 'email', label: 'Email', width: '34%', render: member => <span className="settings-break">{member.email}</span> },
      { key: 'role', label: 'Role', width: 160, render: member => manageable(member) && !lastOwner(member) ? <Select aria-label={`Role for ${member.email}`} value={member.role} onValueChange={role => update.mutate({ id: member.id, role: role as WorkspaceRole })} disabled={update.isPending} options={roleOptions(owner)} /> : roleLabel[member.role] },
      { key: 'actions', label: '', align: 'right', render: member => manageable(member) && !lastOwner(member) ? <Button variant="danger" onClick={() => setRemoving(member)}>Remove</Button> : null },
    ]} />}
    <ConfirmDialog open={removing !== null} onOpenChange={open => { if (!open) setRemoving(null) }} title={`Remove ${removing?.name || removing?.email || 'member'}?`} description="They lose access to this workspace immediately. You can invite them again later." confirmLabel="Remove member" danger pending={remove.isPending} onConfirm={async () => { if (removing) await remove.mutateAsync(removing.id) }} />
  </section>
}

function Invitations({ owner }: { owner: boolean }) {
  const invitations = useApiDef(queries.workspaceInvitations())
  const revoke = useApiMutation((_api, id: string) => workspaceApi.revokeInvitation(id), 'Invitation revoked')
  const [revoking, setRevoking] = useState<WorkspaceInvitation | null>(null)
  return <section className="section stack settings-rule">
    <SectionHeader title="Invitations" />
    {invitations.error ? <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} /> : <DataTable loading={invitations.isPending} skeletonRows={2} rows={invitations.data ?? []} rowKey={invitation => invitation.id} minRows={2} empty={<EmptyState title="No pending invitations" />} columns={[
      { key: 'email', label: 'Email', width: '40%', render: invitation => <span className="settings-break">{invitation.email}</span> },
      { key: 'role', label: 'Role', width: 160, render: invitation => roleLabel[invitation.role] },
      { key: 'expires', label: 'Expires', render: invitation => date(invitation.expiresAt) },
      { key: 'actions', label: '', align: 'right', width: 160, render: invitation => <span className="cluster settings-row-actions"><CopyButton value={invitation.acceptUrl} label="Copy invitation link" />{(owner || invitation.role !== 'owner') && <Button variant="danger" onClick={() => setRevoking(invitation)}>Revoke</Button>}</span> },
    ]} />}
    <ConfirmDialog open={revoking !== null} onOpenChange={open => { if (!open) setRevoking(null) }} title={`Revoke invitation for ${revoking?.email ?? 'this address'}?`} description="The invitation link stops working." confirmLabel="Revoke invitation" danger pending={revoke.isPending} onConfirm={async () => { if (revoking) await revoke.mutateAsync(revoking.id) }} />
  </section>
}

function InviteDialog({ open, owner, onOpenChange }: { open: boolean; owner: boolean; onOpenChange: (open: boolean) => void }) {
  const create = useApiMutation((_api, input: { email: string; role: WorkspaceRole }) => workspaceApi.invite(input), 'Invitation created')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<WorkspaceRole>('member')
  const [emailError, setEmailError] = useState('')
  const [created, setCreated] = useState<WorkspaceInvitation | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    const value = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setEmailError('Enter an email address.'); return }
    setEmailError('')
    try { setCreated(await create.mutateAsync({ email: value, role })) } catch { /* The mutation error is shown in the form. */ }
  }
  function close() { onOpenChange(false); setCreated(null); setEmail(''); setRole('member'); setEmailError(''); create.reset() }
  if (created) return <Dialog open={open} onOpenChange={next => { if (!next) close() }} title="Invitation link" description={`No email is sent. Share this link with ${created.email}. It expires ${date(created.expiresAt)}.`} footer={<Button variant="primary" onClick={close}>Done</Button>}>
    <div className="settings-secret"><code>{created.acceptUrl}</code><CopyButton value={created.acceptUrl} label="Copy invitation link" /></div>
  </Dialog>
  return <Dialog open={open} onOpenChange={next => { if (!create.isPending) { if (next) onOpenChange(true); else close() } }} title="Invite teammate" description="They join after signing in with this email address." footer={<><Button disabled={create.isPending} onClick={close}>Cancel</Button><Button variant="primary" loading={create.isPending} type="submit" form="invite-member">Create invitation</Button></>}>
    <form id="invite-member" className="stack" onSubmit={submit} noValidate>
      <MutationError error={create.error} />
      <Field label="Email" htmlFor="invite-email" error={emailError || fieldError(create.error, 'email')}><Input id="invite-email" type="email" value={email} onChange={event => setEmail(event.target.value)} autoFocus required disabled={create.isPending} placeholder="name@company.com" /></Field>
      <Field label="Role" htmlFor="invite-role" hint={role === 'member' ? 'Members send email and edit content. They can’t manage keys, domains, webhooks or teammates.' : role === 'admin' ? 'Admins manage everything except owners.' : 'Owners manage everything, including other owners.'}><Select id="invite-role" value={role} onValueChange={value => setRole(value as WorkspaceRole)} disabled={create.isPending} options={roleOptions(owner)} /></Field>
    </form>
  </Dialog>
}

// Multi-tenant workspace name, members and invitations.
export function WorkspaceSections() {
  const access = useWorkspaceAccess()
  const [inviting, setInviting] = useState(false)
  const owner = access.role === 'owner'
  return <>
    <WorkspaceName canEdit={access.canAdminister} />
    {access.canAdminister && <><Members owner={owner} onInvite={() => setInviting(true)} /><Invitations owner={owner} /><InviteDialog open={inviting} owner={owner} onOpenChange={setInviting} /></>}
  </>
}
