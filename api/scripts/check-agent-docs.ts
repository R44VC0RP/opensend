import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLlmsText, createMarkdownDocs, createOpenApiDocument } from '../src/openapi-docs.js';

const document = createOpenApiDocument(createApp());
const operations = Object.values(document.paths).flatMap(path => Object.values(path as Record<string, any>)).filter(operation => operation?.operationId);
const llms = createLlmsText(document);
const full = createMarkdownDocs(document)!;
assert.match(llms, /Full Markdown API reference: \/docs\.md/);
assert.match(llms, /OpenAPI 3\.1 definition: \/openapi\.json/);
assert.ok(new TextEncoder().encode(full).length < 512 * 1024, 'Full Markdown reference must remain below 512 KiB.');
for (const operation of operations) {
  const id = operation.operationId as string;
  const path = `/docs/operations/${id}.md`;
  assert.ok(llms.includes(path), `${id} is missing from llms.txt.`);
  const focused = createMarkdownDocs(document, id);
  assert.ok(focused?.includes(`Operation ID: \`${id}\``), `${id} focused Markdown is missing its identity.`);
  assert.ok(focused?.includes('### TypeScript SDK') && focused.includes('### cURL'), `${id} focused Markdown is missing code examples.`);
  assert.ok(!focused?.includes('[object Object]'), `${id} focused Markdown contains an unserialized value.`);
}
assert.equal(createMarkdownDocs(document, 'missingOperation'), null);
console.log(`Verified llms.txt and ${operations.length} focused Markdown operation pages.`);
