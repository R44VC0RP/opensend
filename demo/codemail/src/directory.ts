// What an agent can address: its organization's people and agent mailboxes, plus the mailbox's own
// past contacts (everyone it has corresponded with). Gmail-style recipient resolution turns "maya" or
// "Maya Chen" into an address, preferring teammates, then agent mailboxes, then past contacts.
import { ago } from './format.js';
import { OpenSendError, type Contact } from './opensend.js';

export type Person = { name: string; email: string; role: string };
export type AgentMailbox = { address: string; displayName: string | null };
export type Directory = {
  orgName: string;
  /** The organization's email domain, e.g. acme.opcd.ai. */
  host: string;
  people: Person[];
  /** Agent mailboxes in the organization, loaded on first use. */
  agents: () => Promise<AgentMailbox[]>;
};
/** The sending mailbox's past contacts, loaded on first use. */
export type ContactSource = { mailbox: string; load: (query?: string) => Promise<Contact[]> };
type Kind = 'teammate' | 'agent' | 'contact';
type Entry = { address: string; name: string; kind: Kind; detail: string };
const TIERS: Kind[] = ['teammate', 'agent', 'contact'];

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const normalize = (value: string) => value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
const contactDetail = (contact: Contact) => {
  const parts = [contact.sentCount ? `you sent ${contact.sentCount}` : '', contact.receivedCount ? `they sent ${contact.receivedCount}` : '', !contact.sentCount && !contact.receivedCount ? `on ${contact.copiedCount} received` : ''].filter(Boolean);
  return `${parts.join(', ')}; last ${ago(contact.lastContactAt)}`;
};

async function entries(directory: Directory | undefined, contacts: ContactSource | undefined, query?: string): Promise<Entry[]> {
  const [agents, past] = await Promise.all([directory?.agents().catch(() => []) ?? [], contacts?.load(query).catch(() => []) ?? []]);
  const org: Entry[] = [
    ...(directory?.people ?? []).map(person => ({ address: person.email.toLowerCase(), name: person.name, kind: 'teammate' as const, detail: person.role })),
    ...agents.map(agent => ({ address: agent.address.toLowerCase(), name: agent.displayName ?? '', kind: 'agent' as const, detail: 'agent mailbox' })),
  ];
  const known = new Set(org.map(entry => entry.address));
  return [...org, ...past.filter(contact => !known.has(contact.address)).map(contact => ({ address: contact.address, name: contact.name ?? '', kind: 'contact' as const, detail: contactDetail(contact) }))];
}
const label = (entry: Entry) => `${entry.name ? `${entry.name} <${entry.address}>` : entry.address} (${entry.kind === 'agent' ? 'agent' : entry.kind === 'contact' ? `contact: ${entry.detail}` : entry.detail})`;

/** Labels addresses that belong to the organization (with their name when the message lacks one), for conversation output. */
export function tagger(directory: Directory | undefined): (address: string) => { kind: string; name: string | null } | null {
  if (!directory) return () => null;
  const people = new Map(directory.people.map(person => [person.email.toLowerCase(), person.name]));
  return (address: string) => {
    const lower = address.toLowerCase();
    if (people.has(lower)) return { kind: 'teammate', name: people.get(lower) || null };
    return lower.endsWith(`@${directory.host}`) ? { kind: 'agent', name: null } : null;
  };
}

/**
 * Resolves recipients: email addresses pass through; anything else is looked up by exact name, first
 * name, address or local part, then by partial match, among teammates, agent mailboxes and past contacts
 * (in that order of preference). Unknown or ambiguous names fail with the candidates, so the agent can
 * ask or retry instead of guessing.
 */
export async function resolveRecipients(directory: Directory | undefined, values: string[], contacts?: ContactSource) {
  const addresses: string[] = []; const resolved: string[] = []; const problems: string[] = [];
  let known: Entry[] | undefined;
  const scope = directory ? `${directory.orgName}${contacts ? ` or ${contacts.mailbox}'s contacts` : ''}` : contacts ? `${contacts.mailbox}'s contacts` : 'your contacts';
  for (const raw of values) {
    const value = raw.trim();
    const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1];
    if (EMAIL.test(bracketed ?? value)) { addresses.push((bracketed ?? value).toLowerCase()); continue; }
    if (!directory && !contacts) { problems.push(`"${value}" is not an email address.`); continue; }
    known ??= await entries(directory, contacts);
    const query = normalize(value.replace(/^@/, ''));
    const fields = (entry: Entry) => { const name = normalize(entry.name); return { name, first: name.split(' ')[0] ?? '', local: entry.address.split('@')[0]!, email: entry.address }; };
    const exact = known.filter(entry => { const f = fields(entry); return [f.name, f.first, f.local, f.email].includes(query); });
    const partial = exact.length ? exact : known.filter(entry => { const f = fields(entry); return f.name.includes(query) || f.email.includes(query); });
    // The most trusted tier with a match decides: teammates, then agent mailboxes, then past contacts.
    const tier = TIERS.map(kind => partial.filter(entry => entry.kind === kind)).find(group => group.length) ?? [];
    if (tier.length === 1) { addresses.push(tier[0]!.address); resolved.push(`"${value}" → ${label(tier[0]!)}`); continue; }
    problems.push(tier.length
      ? `"${value}" matches ${tier.length} people: ${tier.slice(0, 6).map(label).join('; ')}. Use the exact address.`
      : `No one named "${value}" in ${scope}. Use an email address, or call find_people to see who's there.`);
  }
  if (problems.length) throw new OpenSendError(422, 'RECIPIENT_UNRESOLVED', problems.join('\n'));
  return { addresses: [...new Set(addresses)], resolved };
}

/** find_people output: the organization directory and the mailbox's recent contacts. */
export async function directoryText(directory: Directory | undefined, contacts: ContactSource | undefined, query?: string) {
  const all = await entries(directory, contacts, query);
  const q = query ? normalize(query) : '';
  const hit = (entry: Entry) => !q || normalize(entry.name).includes(q) || entry.address.includes(q);
  const pick = (kind: Kind) => all.filter(entry => entry.kind === kind && hit(entry));
  const people = pick('teammate'), agents = pick('agent'), past = pick('contact').slice(0, 25);
  const section = (title: string, list: Entry[]) => ['', `${title} (${list.length}):`, ...(list.length ? list.map(entry => `- ${label(entry)}`) : ['- none'])];
  const lines = [
    `${directory ? `${directory.orgName} (@${directory.host})` : 'Contacts'}${q ? ` matching "${query}"` : ''}`,
    ...(directory ? [...section('People', people), ...section('Agent mailboxes', agents)] : []),
    ...(contacts ? section(`Recent contacts of ${contacts.mailbox}`, past) : []),
    '', 'Put names or addresses in to, cc or bcc of send_email, reply and forward, e.g. cc=["maya"]. Names resolve to these addresses, teammates first.',
  ];
  return {
    text: lines.join('\n'),
    people: people.map(({ name, address, detail }) => ({ name, email: address, role: detail })),
    agents: agents.map(({ name, address }) => ({ address, displayName: name || null })),
    contacts: past.map(({ name, address, detail }) => ({ name: name || null, address, activity: detail })),
  };
}
