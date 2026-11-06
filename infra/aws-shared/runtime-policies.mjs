// Offline renderer. The checked-in primary denies edits to *every* Virginia identity.
// Release only narrows that deny with the operator's independently attested adoption manifest.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const account = '438095551154';
export const names = ['opensend-mx', 'opensend-mx-ohio-v8', 'opensend-mx-trusted-v8'];
export function render(manifest) {
  const adopted = JSON.parse(readFileSync(manifest, 'utf8'));
  const prefix = `arn:aws:ses:us-east-1:${account}:identity/`;
  if (!Array.isArray(adopted) || adopted.length !== 12 || new Set(adopted).size !== 12 || adopted.some(a => {
    if (typeof a !== 'string' || !a.startsWith(prefix)) return true;
    const d = a.slice(prefix.length);
    return d.length > 253 || !d.includes('.') || !d.split('.').every(l => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
  })) throw new Error('Expected 12 distinct exact Virginia domain identity ARNs in the adoption manifest');
  const files = ['runtime-policy', 'runtime-ohio-policy', 'runtime-trusted-policy'];
  return Object.fromEntries(names.map((name, i) => {
    const policy = JSON.parse(readFileSync(new URL(`./${files[i]}.json`, import.meta.url), 'utf8').replaceAll('YOUR_AWS_ACCOUNT_ID', account));
    if (!i) policy.Statement.find(s => s.Sid === 'ProtectAdoptedIdentities').Resource = adopted.toSorted();
    if (JSON.stringify(policy).length > 6144) throw new Error(`${name} exceeds 6,144 characters; split, never widen`);
    return [name, policy];
  }));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , manifest, name] = process.argv;
  if (!names.includes(name) || process.argv.length !== 4) throw new Error(`Usage: node runtime-policies.mjs <adopted-arns.json> <${names.join('|')}>`);
  console.log(JSON.stringify(render(manifest)[name]));
}
