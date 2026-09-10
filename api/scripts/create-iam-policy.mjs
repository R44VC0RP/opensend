import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = join(dirname(fileURLToPath(import.meta.url)), '..')
const accountId = process.argv[2] ?? process.env.AWS_ACCOUNT_ID
if (!accountId || !/^\d{12}$/.test(accountId)) {
  console.error('Usage: npm run iam-policy:personal -- <12-digit-aws-account-id>')
  process.exit(1)
}

const template = await readFile(join(directory, 'iam-policy.json'), 'utf8')
if (!template.includes('YOUR_AWS_ACCOUNT_ID')) throw new Error('iam-policy.json does not contain the account ID placeholder.')
const policy = template.replaceAll('YOUR_AWS_ACCOUNT_ID', accountId)
JSON.parse(policy)
const output = join(directory, 'iam-policy-personal.json')
await writeFile(output, policy, { mode: 0o600 })
console.log(`Created ${output}`)
