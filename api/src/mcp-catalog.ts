import { Validator, type Schema } from '@cfworker/json-schema';
import type { Tool } from '@modelcontextprotocol/server';
import type { App } from './core.js';

type ObjectValue = Record<string, any>;
export interface McpOperation { readonly tool: Tool; readonly method: string; readonly path: string; readonly queryParameters: readonly string[]; readonly singlePath?: string; readonly write: boolean; readonly validate: (value: unknown) => boolean; readonly validateOutput: (value: unknown) => boolean; }
const EXCLUDED = new Set(['createApiKey', 'revealWebhookSecret', 'rotateWebhookSecret', 'receiveSesSnsEvent']);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
function invalid(message: string): never { throw new Error(`Invalid MCP catalog: ${message}`); }
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }

// Inspect references before validation. Schemas originate from this app, never a remote service.
function inspectSpec(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 64 || ++budget.nodes > 100_000) invalid('OpenAPI document exceeds structural limits.');
  if (Array.isArray(value)) { for (const entry of value) inspectSpec(entry, depth + 1, budget); }
  else if (object(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (['$id', '$dynamicRef', '$recursiveRef', '__proto__', 'constructor', 'prototype'].includes(key)) invalid('Unsupported OpenAPI schema keyword.');
      if (key === '$ref' && (typeof entry !== 'string' || !/^#\/components\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(entry))) invalid('Only local component references are supported.');
      inspectSpec(entry, depth + 1, budget);
    }
  }
}
function reference(spec: ObjectValue, value: ObjectValue): ObjectValue {
  const seen = new Set<string>();
  while (typeof value.$ref === 'string') {
    if (seen.has(value.$ref) || seen.size >= 32) invalid('Circular or excessively deep OpenAPI reference.');
    seen.add(value.$ref);
    const [, , section, name] = value.$ref.split('/');
    value = spec.components?.[section]?.[name];
    if (!object(value)) invalid('OpenAPI component reference is missing.');
  }
  return value;
}
function inputSchema(spec: ObjectValue, item: ObjectValue, operation: ObjectValue, write: boolean): Tool['inputSchema'] {
  const properties: ObjectValue = Object.create(null);
  const required: string[] = [];
  const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(p => reference(spec, p));
  for (const p of parameters.filter(p => p.in === 'path' || p.in === 'query')) {
    if (typeof p.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(p.name) || !object(p.schema)) invalid('Unsupported OpenAPI parameter.');
    if (Object.hasOwn(properties, p.name) || ['body', 'confirm', 'idempotencyKey'].includes(p.name)) invalid('Conflicting OpenAPI parameter name.');
    properties[p.name] = p.schema;
    if (p.required || p.in === 'path') required.push(p.name);
  }
  if (parameters.some(p => !['path', 'query', 'header'].includes(p.in) || (p.in === 'header' && p.name.toLowerCase() !== 'idempotency-key'))) invalid('Unsupported API parameter location.');
  if (operation.requestBody) {
    const body = reference(spec, operation.requestBody);
    if (!object(body.content?.['application/json']?.schema)) invalid('Only JSON API request bodies are supported.');
    properties.body = body.content['application/json'].schema;
    if (body.required) required.push('body');
  }
  if (write) {
    properties.confirm = { type: 'boolean', const: true, description: 'Explicit authorization to perform this write. Required; not a dry run.' };
    properties.idempotencyKey = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7E]+$', description: 'Forwarded as Idempotency-Key. Reuse the same value when reconciling an uncertain write; the API decides which operations support it.' };
    required.push('confirm');
  }
  return localSchema(spec, { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
}
function outputSchema(spec: ObjectValue, operation: ObjectValue): NonNullable<Tool['outputSchema']> {
  const requestId = { type: ['string', 'null'] };
  const success = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status)).map(([status, value]) => {
    const response = reference(spec, value as ObjectValue);
    const body = response.content?.['application/json']?.schema;
    if (response.content && !object(body)) invalid('Only JSON API responses are supported.');
    return {
      type: 'object',
      properties: { status: { type: 'integer', const: Number(status) }, requestId, response: body ?? { type: 'null' } },
      required: ['status', 'requestId', 'response'], additionalProperties: false,
    };
  });
  if (!success.length) invalid('Tool must declare a successful API response.');
  const error = {
    type: 'object',
    properties: {
      status: { type: ['integer', 'null'] }, requestId, response: {},
      error: {
        type: 'object', properties: {
          code: { type: 'string' }, message: { type: 'string' },
          requestId: { type: 'string' }, field: { type: 'string' }, retryable: { type: 'boolean' },
        }, required: ['code', 'message'], additionalProperties: true,
      },
    },
    required: ['status', 'requestId', 'error'], additionalProperties: false,
  };
  return localSchema(spec, { type: 'object', anyOf: [...success, error] });
}
// Keep shared DTOs in per-tool $defs rather than duplicating them inline.
function localSchema(spec: ObjectValue, root: Tool['inputSchema']): Tool['inputSchema'] {
  const defs: ObjectValue = Object.create(null);
  const visiting = new Set<string>();
  function copy(value: any, depth = 0): any {
    if (depth > 64) invalid('OpenAPI schema reference depth exceeded.');
    if (Array.isArray(value)) return value.map(v => copy(v, depth + 1));
    if (!object(value)) return value;
    const out: ObjectValue = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref') {
        if (!/^#\/components\/schemas\/[A-Za-z0-9_.-]+$/.test(entry)) invalid('Tool schemas must reference local schemas.');
        const name = entry.split('/').at(-1)!;
        if (visiting.has(name)) invalid('Recursive tool schemas are unsupported.');
        if (!Object.hasOwn(defs, name)) {
          if (Object.keys(defs).length >= 256) invalid('Too many tool schema definitions.');
          const target = spec.components?.schemas?.[name];
          if (!object(target)) invalid('Tool schema reference is missing.');
          visiting.add(name);
          defs[name] = copy(target, depth + 1);
          visiting.delete(name);
        }
        out.$ref = `#/$defs/${name}`;
      } else out[key] = copy(entry, depth + 1);
    }
    return out;
  }
  const schema: Tool['inputSchema'] = copy(root);
  if (Object.keys(defs).length) schema.$defs = defs;
  if (bytes(schema) > 512 * 1024) invalid('Tool schema exceeds its byte limit.');
  return schema;
}
function validator(schema: Tool['inputSchema'] | NonNullable<Tool['outputSchema']>): (value: unknown) => boolean {
  const copy = structuredClone(schema) as Schema;
  // Preserve the stdio server's validateFormats:false behavior. Advertise formats,
  // but let the API enforce them: cfworker's URL/email formats are not Zod's.
  // Only visit schema positions, never properties named "format" or enum/const data.
  function annotations(value: Schema | boolean): void {
    if (!object(value)) return;
    delete value.format;
    for (const key of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
      if (object(value[key])) for (const child of Object.values(value[key])) annotations(child as Schema);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      if (Array.isArray(value[key])) for (const child of value[key]) annotations(child);
    }
    for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else']) {
      if (Array.isArray(value[key])) for (const child of value[key]) annotations(child);
      else if (object(value[key])) annotations(value[key]);
    }
  }
  annotations(copy);
  const compiled = new Validator(copy, '2020-12', true);
  return value => compiled.validate(value).valid;
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
// Merge only collections whose list items and detail responses share the same API schema.
// Summary/detail pairs (campaigns, imports, webhook deliveries) stay separate.
const READ_GROUPS = [
  ['getEmails', 'listEmails', 'getEmail', 'emails'],
  ['getContacts', 'listContacts', 'getContact', 'contacts'],
  ['getContactLists', 'listContactLists', 'getContactList', 'contact lists'],
  ['getSegments', 'listSegments', 'getSegment', 'segments'],
  ['getDomains', 'listDomains', 'getDomain', 'domains'],
  ['getWebhooks', 'listWebhooks', 'getWebhook', 'webhooks'],
] as const;
function combineReads(operations: Map<string, McpOperation>, spec: ObjectValue): void {
  for (const [name, listName, detailName, label] of READ_GROUPS) {
    const list = operations.get(listName), detail = operations.get(detailName);
    if (!list || !detail || list.write || detail.write || operations.has(name)) invalid(`Cannot combine ${name}.`);
    const listInput = list.tool.inputSchema as ObjectValue, detailInput = detail.tool.inputSchema as ObjectValue;
    const listOutput = list.tool.outputSchema as ObjectValue, detailOutput = detail.tool.outputSchema as ObjectValue;
    if (listOutput.anyOf.length !== 2 || detailOutput.anyOf.length !== 2 ||
      listOutput.anyOf[0].properties.status.const !== detailOutput.anyOf[0].properties.status.const) invalid(`Success statuses differ for ${name}.`);
    let page = listOutput.anyOf[0].properties.response;
    while (page.$ref) page = listOutput.$defs[page.$ref.split('/').at(-1)];
    if (Object.keys(detailInput.properties).join() !== 'id' || detail.queryParameters.length || listInput.required?.length || Object.hasOwn(listInput.properties, 'id') ||
      page.type !== 'object' || Object.keys(page.properties ?? {}).sort().join() !== 'data,nextCursor' ||
      page.required?.length !== 2 || !page.required.includes('data') || !page.required.includes('nextCursor') || page.properties.data.type !== 'array' ||
      (page.properties.data.minItems ?? 0) > 1 || (page.properties.data.maxItems ?? Infinity) < 1 ||
      !page.properties.nextCursor.type?.includes('null') ||
      JSON.stringify(page.properties.data.items) !== JSON.stringify(detailOutput.anyOf[0].properties.response)) invalid(`List/detail contracts differ for ${name}.`);
    const definitions = { ...listInput.$defs, ...detailInput.$defs };
    const schema: Tool['inputSchema'] = {
      ...listInput, type: 'object',
      properties: { id: { ...detailInput.properties.id, description: 'Optional exact resource ID. Use id alone; omit it to list/filter.' }, ...listInput.properties },
      anyOf: [
        { not: { required: ['id'] } },
        { required: ['id'], properties: Object.fromEntries(list.queryParameters.map(parameter => [parameter, false])) },
      ],
      ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
    };
    if (bytes(schema) > 512 * 1024) invalid(`Tool schema exceeds its byte limit: ${name}.`);
    const listingNotes = spec.paths[list.path][list.method].description;
    const lookupNotes = spec.paths[detail.path][detail.method].description;
    const notes = `${typeof listingNotes === 'string' ? ` Listing: ${listingNotes.slice(0, 4000)}` : ''}${typeof lookupNotes === 'string' && lookupNotes !== listingNotes ? ` Lookup: ${lookupNotes.slice(0, 4000)}` : ''}`;
    const tool: Tool = { ...list.tool, name, inputSchema: schema,
      description: `Get ${label}. Supply id alone for one exact record, or omit id to list/filter one page. Always returns response.data as an array and response.nextCursor; an unknown id remains a 404 error. Pass response.nextCursor as cursor for another page.${name === 'getEmails' ? ' The from/to filters are creation-date bounds, not email addresses; use search for recipient, subject or ID text.' : ''} Permissions and environment are enforced by OpenSend.${notes}`,
    };
    const combined = { ...list, tool, singlePath: detail.path, validate: validator(schema) };
    freeze(tool); Object.freeze(combined);
    operations.delete(listName); operations.delete(detailName); operations.set(name, combined);
  }
}
export function buildMcpCatalog(app: App): ReadonlyMap<string, McpOperation> {
  const spec = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'OpenSend API', version: '0.1.0' } });
  if (bytes(spec) > 2 * 1024 * 1024 || !object(spec.paths)) invalid('OpenAPI document exceeds its byte limit or has no paths.');
  inspectSpec(spec);
  const operations = new Map<string, McpOperation>();
  for (const [path, item] of Object.entries(spec.paths)) {
    if (!/^\/v1\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_-]*\})(?:\/(?:[A-Za-z0-9_-]+|\{[A-Za-z][A-Za-z0-9_-]*\}))*$/.test(path)) continue;
    if (/^\/v1\/(?:auth|dashboard|events)(?:\/|$)/.test(path) || /\/secret$|\/rotate-secret$/.test(path)) continue;
    for (const [method, operation] of Object.entries(item as ObjectValue)) {
      if (!METHODS.has(method) || !object(operation)) continue;
      const name = operation.operationId;
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) invalid('Invalid OpenAPI operationId.');
      if (EXCLUDED.has(name) || (path === '/v1/api-keys' && method !== 'get')) continue;
      if (!operation.security?.some((entry: unknown) => object(entry) && Array.isArray(entry.bearerAuth))) continue;
      const write = method !== 'get';
      if (operations.has(name) || operations.size >= 256) invalid('Duplicate operationId or too many tools.');
      const queryParameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(p => reference(spec, p)).filter(p => p.in === 'query').map(p => p.name as string);
      const tool: Tool = {
        name,
        description: `${name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter: string) => letter.toUpperCase())}. ${write ? 'Write: confirm=true required. ' : ''}Path IDs and query filters are top-level arguments; request data stays in body.${queryParameters.includes('cursor') ? ' Returns one page; pass response.nextCursor as cursor to continue.' : ''} Permissions and environment are enforced by OpenSend.${operation.description ? ` ${String(operation.description).slice(0, 4000)}` : ''} API: ${method.toUpperCase()} ${path}.`,
        inputSchema: inputSchema(spec, item as ObjectValue, operation, write),
        outputSchema: outputSchema(spec, operation),
        annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true },
      };
      const op = { tool, method, path, queryParameters: Object.freeze(queryParameters), write, validate: validator(tool.inputSchema), validateOutput: validator(tool.outputSchema!) };
      freeze(tool); Object.freeze(op);
      operations.set(name, op);
    }
  }
  combineReads(operations, spec);
  if (!operations.size || bytes([...operations.values()].map(o => o.tool)) > 4 * 1024 * 1024) invalid('Tool catalog is empty or exceeds its byte limit.');
  return operations;
}
