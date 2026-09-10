#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { uploadAttachmentBytes } from './upload.js'

function fail(message: string): never { console.error(message); process.exit(1) }
function value(args: string[], flag: string) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
const args = process.argv.slice(2)
if (args[0] !== 'upload' || !args[1] || args.includes('--help')) fail('Usage: npx opensend-js upload <file> --api <url> --token <temporary-token> [--inline --content-id <id>] [--content-type <mime>]')
const path = args[1]
const apiUrl = value(args, '--api')
const token = value(args, '--token')
if (!apiUrl || !token) fail('Both --api and --token are required.')
const inline = args.includes('--inline')
const contentId = value(args, '--content-id')
if (inline && !contentId) fail('--inline requires --content-id.')
const info = await stat(path).catch(() => null)
if (!info?.isFile()) fail('The upload path must be a readable file.')
if (!info.size || info.size > 8 * 1024 * 1024) fail('Attachments must be nonempty and at most 8 MiB.')
try {
  const attachment = await uploadAttachmentBytes({
    apiUrl, token, filename: value(args, '--filename') ?? basename(path), bytes: await readFile(path),
    contentType: value(args, '--content-type'), disposition: inline ? 'inline' : 'attachment', contentId,
    idempotencyKey: value(args, '--idempotency-key'),
  })
  process.stdout.write(`${JSON.stringify(attachment)}\n`)
} catch (error) { fail(error instanceof Error ? error.message : 'Attachment upload failed.') }
