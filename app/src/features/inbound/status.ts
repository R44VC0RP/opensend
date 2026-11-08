import type { Tone } from '../../components/ui'
import type { MailboxDomain, MailboxDomainStatus } from '../../data/types'

export const receivingStatus: Record<MailboxDomainStatus, { label: string; tone: Tone }> = {
  off: { label: 'Off', tone: 'neutral' }, disabled: { label: 'Off', tone: 'neutral' }, provisioning: { label: 'Setting up', tone: 'warning' },
  waiting_for_mx: { label: 'Waiting for MX', tone: 'warning' }, active: { label: 'Receiving', tone: 'success' }, disabling: { label: 'Turning off', tone: 'warning' }, failed: { label: 'Failed', tone: 'danger' },
}

export const mxTone = (state: NonNullable<MailboxDomain['mx']>['state']): Tone => state === 'active' ? 'success' : state === 'missing' || state === 'error' ? 'info' : 'warning'
export const catchAllLabel: Record<MailboxDomain['catchAll'], string> = { create_address: 'Create an address', store: 'Store as unrouted' }
