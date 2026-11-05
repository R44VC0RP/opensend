import { z } from '@hono/zod-openapi';

// Headers that decide identity, recipients, where replies or receipts go, MIME structure, authentication, transport or SES behavior. OpenSend sets
// these itself (or from dedicated fields), so a caller can never override them.
const RESERVED = /^(?:from|sender|reply-to|return-path|to|cc|bcc|subject|date|message-id|mime-version|content-[a-z0-9-]*|dkim-[a-z0-9-]*|arc-[a-z0-9-]*|authentication-results|received[a-z0-9-]*|resent-[a-z0-9-]*|x-ses-[a-z0-9-]*|list-unsubscribe[a-z0-9-]*|auto-submitted|mail-reply-to|mail-followup-to|followup-to|disposition-notification-[a-z0-9-]*|return-receipt-to|errors-to|bounces-to|delivered-to|x-original-to|domainkey-[a-z0-9-]*|feedback-id|tls-required|bimi-[a-z0-9-]*|autocrypt[a-z0-9-]*|openpgp)$/i;
const MESSAGE_ID = '<[\\x21-\\x3b\\x3d\\x3f-\\x7e]+@[\\x21-\\x3b\\x3d\\x3f-\\x7e]+>';
const IN_REPLY_TO = new RegExp(`^${MESSAGE_ID}$`);
const REFERENCES = new RegExp(`^${MESSAGE_ID}(?: ${MESSAGE_ID})*$`);
const MAX_TOTAL = 8192;

export const CustomHeaders = z.array(z.object({
  name: z.string().min(1).max(76).regex(/^[A-Za-z0-9-]+$/, 'Header names use only letters, digits and hyphens.'),
  value: z.string().min(1).max(990).regex(/^[ -~]+$/, 'Header values must be single-line printable ASCII.'),
}).strict()).max(20).superRefine((headers, ctx) => {
  const seen = new Set<string>();
  let total = 0;
  headers.forEach((header, index) => {
    const name = header.name.toLowerCase();
    if (RESERVED.test(name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `${header.name} is set by OpenSend and cannot be passed as a custom header.` });
    if (seen.has(name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `Do not repeat ${header.name}.` });
    seen.add(name);
    if (header.name.length + 2 + header.value.length > 998) ctx.addIssue({ code: 'custom', path: [index, 'value'], message: `${header.name} exceeds the 998-character SMTP line limit.` });
    if (name === 'in-reply-to' && !IN_REPLY_TO.test(header.value)) ctx.addIssue({ code: 'custom', path: [index, 'value'], message: 'In-Reply-To must be exactly one <id@domain> Message-ID.' });
    if (name === 'references' && !REFERENCES.test(header.value)) ctx.addIssue({ code: 'custom', path: [index, 'value'], message: 'References must be <id@domain> Message-IDs separated by single spaces.' });
    total += header.name.length + header.value.length;
  });
  if (total > MAX_TOTAL) ctx.addIssue({ code: 'custom', message: `Custom headers may total at most ${MAX_TOTAL} characters.` });
}).describe('Extra MIME headers, up to 20 and 8 KB in total. Any name is allowed except headers OpenSend controls: From, Sender, Reply-To, Return-Path, To, Cc, Bcc, Subject, Date, Message-ID, MIME-Version, Content-*, DKIM-*, ARC-*, Authentication-Results, Received*, Resent-*, X-SES-*, List-Unsubscribe*, Auto-Submitted, and reply, receipt, trace and transport headers (Mail-Reply-To, Mail-Followup-To, Followup-To, Disposition-Notification-*, Return-Receipt-To, Errors-To, Bounces-To, Delivered-To, X-Original-To, DomainKey-*, Feedback-ID, TLS-Required, BIMI-*, Autocrypt*, OpenPGP). In-Reply-To and References must be <id@domain> Message-IDs and thread the message in the recipient\'s mail client.');

export type CustomHeader = { name: string; value: string };

const unbracket = (value: string) => [...value.matchAll(/<([^<>]+)>/g)].map(match => match[1]!);

/** Splits threading headers out so callers can store them on the message; the rest pass through unchanged. */
export function splitThreadingHeaders(headers: CustomHeader[]) {
  const find = (name: string) => headers.find(header => header.name.toLowerCase() === name);
  const inReplyTo = find('in-reply-to'), references = find('references');
  return {
    inReplyTo: inReplyTo ? unbracket(inReplyTo.value)[0]! : null,
    references: references ? unbracket(references.value) : [],
    present: !!(inReplyTo || references),
    rest: headers.filter(header => header !== inReplyTo && header !== references),
  };
}
