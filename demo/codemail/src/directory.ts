// The organization directory an agent sees: its people and its other agent mailboxes, plus the
// Gmail-style recipient resolution that turns "maya" or "Maya Chen" into an address.
import { OpenSendError } from './opensend.js';

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
type Entry = { address: string; name: string; kind: 'teammate' | 'agent'; detail: string };

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const normalize = (value: string) => value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

async function entries(directory: Directory): Promise<Entry[]> {
  const agents = await directory.agents().catch(() => []);
  return [
    ...directory.people.map(person => ({ address: person.email.toLowerCase(), name: person.name, kind: 'teammate' as const, detail: person.role })),
    ...agents.map(agent => ({ address: agent.address.toLowerCase(), name: agent.displayName ?? '', kind: 'agent' as const, detail: 'agent mailbox' })),
  ];
}
const label = (entry: Entry) => `${entry.name ? `${entry.name} <${entry.address}>` : entry.address} (${entry.kind === 'agent' ? 'agent' : entry.detail})`;

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
 * Resolves recipients: email addresses pass through; anything else is looked up by name, first name,
 * email or local part among the organization's people and agent mailboxes. Unknown or ambiguous names
 * fail with the candidates, so the agent can ask or retry instead of guessing.
 */
export async function resolveRecipients(directory: Directory | undefined, values: string[]) {
  const addresses: string[] = []; const resolved: string[] = []; const problems: string[] = [];
  let known: Entry[] | undefined;
  for (const raw of values) {
    const value = raw.trim();
    const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>\s*$/)?.[1];
    if (EMAIL.test(bracketed ?? value)) { addresses.push((bracketed ?? value).toLowerCase()); continue; }
    if (!directory) { problems.push(`"${value}" is not an email address.`); continue; }
    known ??= await entries(directory);
    const query = normalize(value.replace(/^@/, ''));
    const fields = (entry: Entry) => { const name = normalize(entry.name); const local = entry.address.split('@')[0]!; return { name, first: name.split(' ')[0] ?? '', local, email: entry.address }; };
    let matches = known.filter(entry => { const f = fields(entry); return [f.name, f.first, f.local, f.email].includes(query); });
    if (!matches.length) matches = known.filter(entry => { const f = fields(entry); return f.name.includes(query) || f.email.includes(query); });
    // Prefer people over agent mailboxes when both match a name.
    if (matches.length > 1 && matches.some(entry => entry.kind === 'teammate') && matches.filter(entry => entry.kind === 'teammate').length === 1) matches = matches.filter(entry => entry.kind === 'teammate');
    if (matches.length === 1) { addresses.push(matches[0]!.address); resolved.push(`"${value}" → ${label(matches[0]!)}`); continue; }
    problems.push(matches.length
      ? `"${value}" matches ${matches.length} people in ${directory.orgName}: ${matches.slice(0, 6).map(label).join('; ')}. Use the exact address.`
      : `No one named "${value}" in ${directory.orgName}. Use an email address, or call find_people to see who's there.`);
  }
  if (problems.length) throw new OpenSendError(422, 'RECIPIENT_UNRESOLVED', problems.join('\n'));
  return { addresses: [...new Set(addresses)], resolved };
}

/** find_people output. */
export async function directoryText(directory: Directory, query?: string) {
  const all = await entries(directory);
  const q = query ? normalize(query) : '';
  const hit = (entry: Entry) => !q || normalize(entry.name).includes(q) || entry.address.includes(q);
  const people = all.filter(entry => entry.kind === 'teammate' && hit(entry));
  const agents = all.filter(entry => entry.kind === 'agent' && hit(entry));
  const lines = [
    `${directory.orgName} (@${directory.host})${q ? ` matching "${query}"` : ''}`,
    '', `People (${people.length}):`, ...(people.length ? people.map(entry => `- ${label(entry)}`) : ['- none']),
    '', `Agent mailboxes (${agents.length}):`, ...(agents.length ? agents.map(entry => `- ${label(entry)}`) : ['- none']),
    '', 'Put names or addresses in to, cc or bcc of send_email, reply and forward, e.g. cc=["maya"]. Names resolve to these addresses.',
  ];
  return { text: lines.join('\n'), people: people.map(({ name, address, detail }) => ({ name, email: address, role: detail })), agents: agents.map(({ name, address }) => ({ address, displayName: name || null })) };
}
