import { Validator, type Schema } from '@cfworker/json-schema';
import type { Tool } from '@modelcontextprotocol/server';
import type { App } from './core.js';

type ObjectValue = Record<string, any>;
export interface McpStepResult { status: number; requestId: string | null; response: any; }
export interface McpPlan { steps: readonly { operation: McpOperation; args: ObjectValue }[]; parallel?: boolean; combine?: (results: McpStepResult[]) => McpStepResult; }
export interface McpOperation { readonly tool: Tool; readonly method: string; readonly path: string; readonly queryParameters: readonly string[]; readonly singlePath?: string; readonly write: boolean; readonly validate: (value: unknown) => boolean; readonly validateOutput: (value: unknown) => boolean; readonly plan?: (args: ObjectValue) => McpPlan; }
const EXCLUDED = new Set(['createApiKey', 'revealWebhookSecret', 'rotateWebhookSecret', 'receiveSesSnsEvent']);
const EMAIL_SEND_TOOLS = new Set(['sendEmail', 'sendEmailBatch', 'testCampaign', 'sendCampaign', 'scheduleCampaign']);
export const EMAIL_SEND_CONFIRMATION = 'Before sending or scheduling any email, including campaign tests, present the recipients or audience, message content or reviewed campaign revision, and send time, then obtain explicit user confirmation. OAuth access, a request to prepare a draft, or setting confirm=true is not confirmation. Ask again if the recipients, content, or timing changes.';
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
  return schema as unknown as Tool['inputSchema'];
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
      // Keep an object-shaped signature for Code Mode; a constraint-only anyOf
      // branch otherwise collapses the generated argument type to unknown.
      dependentSchemas: { id: { properties: Object.fromEntries(list.queryParameters.map(parameter => [parameter, false])) } },
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
const genericOutput: NonNullable<Tool['outputSchema']> = {
  type: 'object', anyOf: [
    { type: 'object', properties: { status: { type: 'integer' }, requestId: { type: ['string', 'null'] }, response: {} }, required: ['status', 'requestId', 'response'], additionalProperties: false },
    { type: 'object', properties: { status: { type: ['integer', 'null'] }, requestId: { type: ['string', 'null'] }, response: {}, error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'], additionalProperties: true } }, required: ['status', 'requestId', 'error'], additionalProperties: false },
  ],
};
function pageOutput(): NonNullable<Tool['outputSchema']> {
  const schema = structuredClone(genericOutput) as ObjectValue;
  schema.anyOf[0].properties.response = { type: 'object', properties: { data: { type: 'array', items: {} }, nextCursor: { type: ['string', 'null'] } }, required: ['data', 'nextCursor'], additionalProperties: false };
  return schema as NonNullable<Tool['outputSchema']>;
}
const campaignReviewOutput: NonNullable<Tool['outputSchema']> = {
  type: 'object', anyOf: [
    { type: 'object', properties: { status: { type: 'integer' }, requestId: { type: ['string', 'null'] }, response: { type: 'object', properties: {
      id: { type: 'string' }, campaignId: { type: 'string' }, revision: { type: 'integer' }, contentHash: { type: 'string' }, createdAt: { type: 'string' },
      matched: { type: 'integer' }, eligible: { type: 'integer' }, suppressed: { type: 'integer' }, unsubscribed: { type: 'integer' },
      preview: { type: 'object', properties: { html: { type: 'string' }, text: { type: 'string' } }, required: ['html', 'text'], additionalProperties: false },
    }, required: ['id', 'campaignId', 'revision', 'contentHash', 'createdAt', 'matched', 'eligible', 'suppressed', 'unsubscribed', 'preview'], additionalProperties: false } }, required: ['status', 'requestId', 'response'], additionalProperties: false },
    structuredClone((genericOutput as ObjectValue).anyOf[1]),
  ],
};
function alias(source: McpOperation, name: string, description: string): McpOperation {
  const tool: Tool = { ...source.tool, name, description };
  const operation = { ...source, tool };
  freeze(tool); Object.freeze(operation); return operation;
}
function actionSchema(actions: Record<string, McpOperation>, field = 'action', requireConfirmation = false): Tool['inputSchema'] {
  const defs: ObjectValue = {};
  const branches = Object.entries(actions).map(([action, operation]) => {
    const schema = structuredClone(operation.tool.inputSchema) as ObjectValue;
    for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
      if (defs[name] && JSON.stringify(defs[name]) !== JSON.stringify(definition)) invalid(`Conflicting schema definition ${name}.`);
      defs[name] = definition;
    }
    delete schema.$defs;
    schema.properties = { [field]: { type: 'string', const: action }, ...(schema.properties ?? {}), ...(requireConfirmation && !operation.write ? { confirm: { type: 'boolean', const: true, description: 'Explicit authorization to perform this workflow action.' } } : {}) };
    schema.required = [...new Set([field, ...(schema.required ?? []), ...(requireConfirmation && !operation.write ? ['confirm'] : [])])];
    return schema;
  });
  const properties: ObjectValue = { [field]: { type: 'string', enum: Object.keys(actions) } };
  for (const branch of branches) for (const [name, schema] of Object.entries(branch.properties ?? {})) {
    if (name === field) continue;
    if (!properties[name]) properties[name] = schema;
    else if (JSON.stringify(properties[name]) !== JSON.stringify(schema)) {
      const options = properties[name].anyOf ?? [properties[name]];
      if (!options.some((candidate: unknown) => JSON.stringify(candidate) === JSON.stringify(schema))) properties[name] = { anyOf: [...options, schema] };
    }
  }
  return { type: 'object', properties, required: [field], oneOf: branches, ...(Object.keys(defs).length ? { $defs: defs } : {}) };
}
function custom(name: string, description: string, input: Tool['inputSchema'], write: boolean, plan: (args: ObjectValue) => McpPlan, outputSchema: NonNullable<Tool['outputSchema']> = genericOutput): McpOperation {
  const output = structuredClone(outputSchema);
  const tool: Tool = { name, description, inputSchema: input, outputSchema: output, annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true } };
  const operation: McpOperation = { tool, method: 'custom', path: '/v1/custom', queryParameters: [], write, validate: validator(input), validateOutput: validator(output), plan };
  freeze(tool); Object.freeze(operation); return operation;
}
function actionOutputSchema(actions: Record<string, McpOperation>): NonNullable<Tool['outputSchema']> {
  const defs: ObjectValue = {}, variants: unknown[] = [];
  for (const operation of Object.values(actions)) {
    const schema = structuredClone(operation.tool.outputSchema) as ObjectValue;
    for (const [name, definition] of Object.entries(schema.$defs ?? {})) {
      if (defs[name] && JSON.stringify(defs[name]) !== JSON.stringify(definition)) invalid(`Conflicting output schema definition ${name}.`);
      defs[name] = definition;
    }
    if (!Array.isArray(schema.anyOf)) invalid('Action source output must use anyOf.');
    for (const variant of schema.anyOf) if (!variants.some(candidate => JSON.stringify(candidate) === JSON.stringify(variant))) variants.push(variant);
  }
  return { type: 'object', anyOf: variants as any[], ...(Object.keys(defs).length ? { $defs: defs } : {}) };
}
function actionTool(name: string, description: string, actions: Record<string, McpOperation>, field = 'action') {
  const write = Object.values(actions).some(operation => operation.write);
  return custom(name, description, actionSchema(actions, field, write), write, args => {
    const action = args[field]; const operation = actions[action];
    if (!operation) invalid(`Unknown ${field} for ${name}.`);
    const next = { ...args }; delete next[field];
    if (!operation.write) { delete next.confirm; delete next.idempotencyKey; }
    return { steps: [{ operation, args: next }] };
  }, actionOutputSchema(actions));
}
function findSchema(source: McpOperation, extra: ObjectValue = {}): Tool['inputSchema'] {
  const schema = structuredClone(source.tool.inputSchema) as ObjectValue;
  schema.properties = { ...(schema.properties ?? {}), ...extra };
  return schema as unknown as Tool['inputSchema'];
}
function curate(combined: Map<string, McpOperation>, raw: Map<string, McpOperation>): ReadonlyMap<string, McpOperation> {
  const need = (name: string, source = combined) => source.get(name) ?? invalid(`Missing source operation ${name}.`);
  const result = new Map<string, McpOperation>();
  const add = (operation: McpOperation) => { if (result.has(operation.tool.name)) invalid(`Duplicate curated tool ${operation.tool.name}.`); result.set(operation.tool.name, operation); };
  const direct = (name: string, description: string, source: string) => add(alias(need(source), name, description));

  const campaignList = need('listCampaigns', raw), campaignDetail = need('getCampaign', raw);
  const campaignFindSchema = findSchema(campaignList, { id: { type: 'string', minLength: 1, maxLength: 120 } }) as ObjectValue;
  campaignFindSchema.dependentSchemas = { id: { properties: Object.fromEntries(campaignList.queryParameters.map(parameter => [parameter, false])) } };
  add(custom('findCampaigns', 'List and filter campaign summaries, or supply id alone to retrieve one complete campaign draft.', campaignFindSchema as Tool['inputSchema'], false, args => {
    if (typeof args.id === 'string') return { steps: [{ operation: campaignDetail, args: { id: args.id } }], combine: ([value]) => ({ ...value, response: { data: [value.response], nextCursor: null } }) };
    return { steps: [{ operation: campaignList, args }] };
  }, pageOutput()));
  add(actionTool('saveCampaign', 'Create a campaign draft or update its complete revision-protected draft.', { create: need('createCampaign', raw), update: need('updateCampaign', raw) }));
  const previewCampaign = need('previewCampaign', raw), reviewCampaign = need('reviewCampaign', raw);
  add(custom('reviewCampaign', `Render, validate and review a campaign revision, returning its message preview, eligible audience counts and delivery review ID. ${EMAIL_SEND_CONFIRMATION}`, reviewCampaign.tool.inputSchema, true, args => ({
    steps: [{ operation: previewCampaign, args: { id: args.id } }, { operation: reviewCampaign, args }],
    combine: ([preview, review]) => ({ ...review, response: { ...review.response, preview: preview.response } }),
  }), campaignReviewOutput));
  add(actionTool('deliverCampaign', `Test, send, schedule or cancel campaign delivery. ${EMAIL_SEND_CONFIRMATION}`, { test: need('testCampaign', raw), send: need('sendCampaign', raw), schedule: need('scheduleCampaign', raw), cancel: need('cancelCampaign', raw) }, 'mode'));
  direct('archiveCampaign', 'Archive or restore a campaign without deleting its content or history.', 'setCampaignArchived');
  direct('deleteCampaign', 'Permanently delete an eligible campaign.', 'deleteCampaign');

  direct('findContacts', 'List and filter contacts, or supply id alone to retrieve one contact with its list memberships.', 'getContacts');
  add(actionTool('saveContact', 'Create or update a contact profile, or record explicit consent evidence. Profile metadata never implies consent.', { create: need('createContact', raw), update: need('updateContact', raw), consent: need('updateContactConsent', raw) }));
  direct('deleteContact', 'Remove a contact profile and memberships while retaining required consent and suppression safeguards.', 'deleteContact');
  add(actionTool('importContacts', 'Preview, inspect, list or commit CSV contact imports, including mapped contact metadata.', { preview: need('previewContactImport', raw), get: need('getContactImport', raw), list: need('listContactImports', raw), commit: need('commitContactImport', raw) }));

  const lists = need('getContactLists');
  add(custom('findLists', 'List and search contact lists, or supply id alone to retrieve one list and its members.', findSchema(lists, { includeMembers: { type: 'boolean', default: true } }), false, args => {
    if (typeof args.id !== 'string') { const next = { ...args }; delete next.includeMembers; return { steps: [{ operation: lists, args: next }] }; }
    const detail = need('getContactList', raw), members = need('listListMembers', raw);
    const steps: Array<{ operation: McpOperation; args: ObjectValue }> = [{ operation: detail, args: { id: args.id } }];
    if (args.includeMembers !== false) steps.push({ operation: members, args: { id: args.id, limit: 100 } });
    return { steps, parallel: true, combine: values => ({ ...values[0]!, response: { data: [{ ...values[0]!.response, ...(values[1] ? { members: values[1].response.data, membersNextCursor: values[1].response.nextCursor } : {}) }], nextCursor: null } }) };
  }, pageOutput()));
  add(actionTool('saveList', 'Create or update a contact list.', { create: need('createContactList', raw), update: need('updateContactList', raw) }));
  add(actionTool('setListMembers', 'Add contacts to a list or remove one contact from it.', { add: need('addListMembers', raw), remove: need('removeListMember', raw) }));
  direct('deleteList', 'Delete a contact list.', 'deleteContactList');

  direct('findSegments', 'List and search dynamic segments, or supply id alone to retrieve one segment and its rules.', 'getSegments');
  add(actionTool('saveSegment', 'Create or update a dynamic segment, or preview its current matching and eligible contacts.', { create: need('createSegment', raw), update: need('updateSegment', raw), preview: need('previewSegment', raw) }));
  direct('deleteSegment', 'Delete a dynamic segment.', 'deleteSegment');

  const emails = need('getEmails'), emailDetail = need('getEmail', raw), emailContent = need('getEmailContent', raw), emailEvents = need('listEmailEvents', raw);
  add(custom('findEmails', 'List and filter email records, or supply id alone to retrieve one email with its content and delivery events.', emails.tool.inputSchema, false, args => {
    if (typeof args.id !== 'string') return { steps: [{ operation: emails, args }] };
    return { steps: [{ operation: emailDetail, args: { id: args.id } }, { operation: emailContent, args: { id: args.id } }, { operation: emailEvents, args: { id: args.id, limit: 100 } }], parallel: true,
      combine: ([detail, content, events]) => ({ ...detail, response: { data: [{ ...detail.response, content: content.response, events: events.response.data, eventsNextCursor: events.response.nextCursor }], nextCursor: null } }) };
  }, pageOutput()));
  add(actionTool('sendEmail', `Send one email or a batch. ${EMAIL_SEND_CONFIRMATION}`, { single: need('sendEmail', raw), batch: need('sendEmailBatch', raw) }, 'mode'));

  add(actionTool('getAttachment', 'Retrieve attachment metadata or its private canonical base64 content.', { metadata: need('getAttachment', raw), content: need('getAttachmentContent', raw) }, 'include'));
  direct('uploadAttachment', 'Upload small attachment content already available as canonical base64. For a local file, create a short-lived agent token and use npx opensend-js upload so file bytes bypass model context.', 'uploadAttachment');
  direct('deleteAttachment', 'Delete an attachment that is not referenced by retained mail or campaigns.', 'deleteAttachment');

  const webhooks = need('getWebhooks');
  add(custom('findWebhooks', 'List webhook endpoints, or supply id alone to retrieve one endpoint with recent deliveries.', webhooks.tool.inputSchema, false, args => {
    if (typeof args.id !== 'string') return { steps: [{ operation: webhooks, args }] };
    return { steps: [{ operation: need('getWebhook', raw), args: { id: args.id } }, { operation: need('listWebhookDeliveries', raw), args: { id: args.id, limit: 100 } }], parallel: true,
      combine: ([detail, deliveries]) => ({ ...detail, response: { data: [{ ...detail.response, deliveries: deliveries.response.data, deliveriesNextCursor: deliveries.response.nextCursor }], nextCursor: null } }) };
  }, pageOutput()));
  add(actionTool('saveWebhook', 'Create or update a webhook endpoint and its event filters.', { create: need('createWebhook', raw), update: need('updateWebhook', raw) }));
  direct('deleteWebhook', 'Delete a webhook endpoint.', 'deleteWebhook');
  direct('testWebhook', 'Queue a synthetic delivery to a webhook endpoint.', 'testWebhook');
  direct('retryWebhookDelivery', 'Retry one failed webhook delivery.', 'retryWebhookDelivery');
  direct('getMetrics', 'Query created-cohort sending, delivery, bounce, complaint, open and click metrics.', 'getMetrics');
  direct('createAgentToken', 'Create a nonrefreshable API token lasting 30 seconds to 24 hours for temporary uncommitted scripts. Supports read or read-plus-send access and optional sender-domain restrictions.', 'createAgentToken');

  if (result.size !== 29) invalid(`Curated catalog must contain exactly 29 tools, got ${result.size}.`);
  return result;
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
        description: `${name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (letter: string) => letter.toUpperCase())}. ${EMAIL_SEND_TOOLS.has(name) ? `${EMAIL_SEND_CONFIRMATION} ` : ''}${write ? 'Write: confirm=true required. ' : ''}Path IDs and query filters are top-level arguments; request data stays in body.${queryParameters.includes('cursor') ? ' Returns one page; pass response.nextCursor as cursor to continue.' : ''} Permissions and environment are enforced by OpenSend.${operation.description ? ` ${String(operation.description).slice(0, 4000)}` : ''} API: ${method.toUpperCase()} ${path}.`,
        inputSchema: inputSchema(spec, item as ObjectValue, operation, write),
        outputSchema: outputSchema(spec, operation),
        annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: !write, openWorldHint: true },
      };
      const op = { tool, method, path, queryParameters: Object.freeze(queryParameters), write, validate: validator(tool.inputSchema), validateOutput: validator(tool.outputSchema!) };
      freeze(tool); Object.freeze(op);
      operations.set(name, op);
    }
  }
  const raw = new Map(operations);
  combineReads(operations, spec);
  const curated = curate(operations, raw);
  if (bytes([...curated.values()].map(o => o.tool)) > 4 * 1024 * 1024) invalid('Tool catalog exceeds its byte limit.');
  return curated;
}
