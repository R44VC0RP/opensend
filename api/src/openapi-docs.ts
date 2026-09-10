import type { App } from './core.js';

type Json = Record<string, any>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function resolve(document: Json, schema: Json | undefined, seen = new Set<string>()): Json {
  if (!schema) return {};
  if (typeof schema.$ref !== 'string') return schema;
  if (seen.has(schema.$ref)) return {};
  seen.add(schema.$ref);
  const [, , section, name] = schema.$ref.split('/');
  return resolve(document, document.components?.[section]?.[name], seen);
}

function sampleString(name: string, schema: Json): string {
  if (schema.const !== undefined) return String(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return String(schema.enum[0]);
  if (typeof schema.default === 'string') return schema.default;
  if (typeof schema.example === 'string') return schema.example;
  if (/^from$/i.test(name)) return 'sender@example.com';
  if (schema.format === 'email' || /^(?:to|email|replyTo)$/i.test(name)) return 'recipient@example.com';
  if (schema.format === 'date-time' || /(?:At|Date)$/i.test(name)) return '2026-09-18T19:00:00Z';
  if (schema.format === 'uri' || /url$/i.test(name)) return 'https://example.com/webhook';
  if (/region/i.test(name)) return 'us-east-1';
  if (/subject/i.test(name)) return 'Hello from OpenSend';
  if (/html/i.test(name)) return '<h1>Hello</h1><p>Your message is ready.</p>';
  if (/text|markdown|description|purpose/i.test(name)) return 'Your message is ready.';
  if (/name/i.test(name)) return 'Example';
  if (/filename/i.test(name)) return 'document.pdf';
  if (/contentType/i.test(name)) return 'application/pdf';
  if (/contentId/i.test(name)) return 'asset';
  if (/idempotency/i.test(name)) return 'request-123';
  if (/id$/i.test(name)) return `${name.replace(/Id$/i, '').toLowerCase() || 'resource'}_123`;
  if (schema.pattern?.includes('^[a-z0-9-]')) return 'example';
  return 'example';
}

function sample(document: Json, input: Json | undefined, name = 'value', depth = 0): any {
  if (depth > 8) return undefined;
  const schema = resolve(document, input);
  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union) && union.length) return sample(document, union[0], name, depth + 1);
  if (Array.isArray(schema.type)) {
    const type = schema.type.find((value: string) => value !== 'null');
    return sample(document, { ...schema, type }, name, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === 'string' || schema.format || schema.pattern) return sampleString(name, schema);
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? (schema.exclusiveMinimum !== undefined ? Number(schema.exclusiveMinimum) + 1 : 1);
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [sample(document, schema.items, name.replace(/s$/, ''), depth + 1)].filter(value => value !== undefined);
  if (schema.type === 'object' || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    return Object.fromEntries(Object.entries<Json>(schema.properties ?? {}).filter(([key, value]) => required.has(key) || value.default !== undefined).map(([key, value]) => [key, sample(document, value, key, depth + 1)]).filter(([, value]) => value !== undefined));
  }
  return undefined;
}

function parameters(document: Json, pathItem: Json, operation: Json, location: string) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(parameter => resolve(document, parameter)).filter(parameter => parameter.in === location);
}

function sdkSample(document: Json, path: string, method: string, pathItem: Json, operation: Json): string {
  const options: Json = {};
  const pathParameters = parameters(document, pathItem, operation, 'path');
  const queryParameters = parameters(document, pathItem, operation, 'query').filter(parameter => parameter.required);
  const headerParameters = parameters(document, pathItem, operation, 'header').filter(parameter => parameter.required && parameter.name.toLowerCase() !== 'authorization');
  if (pathParameters.length) options.path = Object.fromEntries(pathParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  if (queryParameters.length) options.query = Object.fromEntries(queryParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  if (headerParameters.length) options.headers = Object.fromEntries(headerParameters.map(parameter => [parameter.name, sample(document, parameter.schema, parameter.name)]));
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  if (bodySchema) {
    options.body = sample(document, bodySchema, 'body');
    const completeEmail = (email: Json) => ({ ...email, subject: email.subject ?? 'Hello from OpenSend', text: email.text ?? 'Your message is ready.' });
    if (operation.operationId === 'sendEmail') options.body = completeEmail(options.body);
    if (operation.operationId === 'sendEmailBatch') options.body.emails = options.body.emails.map(completeEmail);
  }
  const renderedOptions = Object.entries(options).map(([key, value]) => `  ${key}: ${JSON.stringify(value, null, 2).replaceAll('\n', '\n  ')},`).join('\n');
  return `import { createClient } from 'opensend-js/client';\nimport { ${operation.operationId} } from 'opensend-js';\n\nconst client = createClient({\n  baseUrl: 'https://opensend.anoma.ly',\n  auth: scheme => scheme.scheme === 'bearer'\n    ? process.env.OPENSEND_API_KEY\n    : undefined,\n});\n\nconst result = await ${operation.operationId}({\n  client,\n${renderedOptions ? `${renderedOptions}\n` : ''}  throwOnError: true,\n});\n\nconsole.log(result.data);`;
}

function curlSample(document: Json, path: string, method: string, pathItem: Json, operation: Json): string {
  let target = path;
  for (const parameter of parameters(document, pathItem, operation, 'path')) target = target.replace(`{${parameter.name}}`, encodeURIComponent(String(sample(document, parameter.schema, parameter.name))));
  const query = parameters(document, pathItem, operation, 'query').filter(parameter => parameter.required).map(parameter => `${encodeURIComponent(parameter.name)}=${encodeURIComponent(String(sample(document, parameter.schema, parameter.name)))}`);
  if (query.length) target += `?${query.join('&')}`;
  const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
  let body = bodySchema ? sample(document, bodySchema, 'body') : undefined;
  const completeEmail = (email: Json) => ({ ...email, subject: email.subject ?? 'Hello from OpenSend', text: email.text ?? 'Your message is ready.' });
  if (operation.operationId === 'sendEmail') body = completeEmail(body);
  if (operation.operationId === 'sendEmailBatch') body.emails = body.emails.map(completeEmail);
  const lines = [`curl --request ${method.toUpperCase()} \\`, `  --url 'https://opensend.anoma.ly${target}' \\`, `  --header 'Authorization: Bearer $OPENSEND_API_KEY'`];
  lines[2] = `  --header "Authorization: Bearer $OPENSEND_API_KEY"`;
  if (bodySchema) { lines[lines.length - 1] += ' \\'; lines.push(`  --header 'Content-Type: application/json' \\`, `  --data '${JSON.stringify(body, null, 2)}'`); }
  return lines.join('\n');
}

export function createOpenApiDocument(app: App) {
  const document = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'OpenSend API', version: '0.1.0', description: 'Transactional and marketing email. 202 means queued, not delivered. Test keys simulate sending.' } }) as Json;
  for (const [path, pathItem] of Object.entries<Json>(document.paths ?? {})) for (const method of METHODS) {
    const operation = pathItem[method];
    if (!operation?.operationId) continue;
    operation['x-codeSamples'] = [
      { lang: 'TypeScript', label: 'TypeScript SDK', source: sdkSample(document, path, method, pathItem, operation) },
      { lang: 'Shell', label: 'cURL', source: curlSample(document, path, method, pathItem, operation) },
    ];
  }
  return document;
}
