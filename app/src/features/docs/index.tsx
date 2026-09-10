import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { CopyButton, EmptyState, ErrorState, Input, SkeletonText, Tabs } from '../../components/ui'
import './docs.css'

type Schema = Record<string, any>
type Operation = { id: string; method: string; path: string; tag: string; summary: string; description: string; parameters: Schema[]; requestBody?: Schema; responses: Record<string, Schema>; samples: {lang: string; label: string; source: string}[] }
type Document = { info: {title: string; version: string; description?: string}; paths: Record<string, Record<string, Schema>>; components?: {schemas?: Record<string, Schema>; parameters?: Record<string, Schema>} }
const methods = ['get', 'post', 'put', 'patch', 'delete']
function operationTitle(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((word, index) => /^mcp$/i.test(word) ? 'MCP' : index === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()).join(' ')
}

function resolve(document: Document, value?: Schema): Schema {
  if (!value?.$ref) return value ?? {}
  const [, , section, name] = value.$ref.split('/')
  return (document.components as Schema | undefined)?.[section]?.[name] ?? {}
}
function typeLabel(document: Document, input: Schema): string {
  const schema = resolve(document, input)
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map((value: Schema) => typeLabel(document, value)).join(' or ')
  if (Array.isArray(schema.type)) return schema.type.join(' or ')
  if (schema.type === 'array') return `${typeLabel(document, schema.items)}[]`
  return schema.type ?? (schema.properties ? 'object' : 'value')
}
function schemaName(input: Schema): string | null { return typeof input?.$ref === 'string' ? input.$ref.split('/').at(-1) ?? null : null }
function operations(document?: Document): Operation[] {
  if (!document) return []
  const result: Operation[] = []
  for (const [path, pathItem] of Object.entries(document.paths)) for (const method of methods) {
    const operation = pathItem[method]
    if (!operation?.operationId) continue
    result.push({ id: operation.operationId, method, path, tag: operation.tags?.[0] ?? 'API', summary: operation.summary ?? operationTitle(operation.operationId), description: operation.description ?? '', parameters: [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])], requestBody: operation.requestBody, responses: operation.responses ?? {}, samples: operation['x-codeSamples'] ?? [] })
  }
  return result
}

function SchemaDefinition({ document, input }: {document: Document; input: Schema}) {
  const name = schemaName(input)
  const schema = resolve(document, input)
  const required = new Set<string>(schema.required ?? [])
  const properties = Object.entries<Schema>(schema.properties ?? {})
  if (!properties.length) return <div className="docs-schema-inline"><code>{name ?? typeLabel(document, schema)}</code>{schema.description && <p>{schema.description}</p>}</div>
  return <div className="docs-schema">
    {name && <code className="docs-schema-name">{name}</code>}
    {schema.description && <p className="muted">{schema.description}</p>}
    <div className="docs-field-list">{properties.map(([property, definition]) => <div className="docs-field" key={property}>
      <div><code>{property}</code>{required.has(property) && <span className="docs-required">required</span>}<span className="docs-type">{typeLabel(document, definition)}</span></div>
      {resolve(document, definition).description && <p>{resolve(document, definition).description}</p>}
    </div>)}</div>
  </div>
}

function OperationPage({ document, operation }: {document: Document; operation: Operation}) {
  const [language, setLanguage] = useState(operation.samples[0]?.label ?? 'TypeScript SDK')
  useEffect(() => setLanguage(operation.samples[0]?.label ?? 'TypeScript SDK'), [operation.id])
  const sample = operation.samples.find(item => item.label === language) ?? operation.samples[0]
  const body = operation.requestBody?.content?.['application/json']?.schema
  const parameters = operation.parameters.map(parameter => resolve(document, parameter))
  return <article className="docs-operation">
    <header className="docs-operation-header">
      <h1>{operation.summary}</h1>
      <div className="docs-endpoint"><span data-method={operation.method}>{operation.method}</span><code>{operation.path}</code><CopyButton value={operation.path} label="Copy endpoint path" /></div>
      {operation.description && <p>{operation.description}</p>}
    </header>
    {sample && <section className="docs-section" aria-labelledby="docs-example-title">
      <div className="docs-section-heading"><h2 id="docs-example-title">Example</h2><CopyButton key={`${operation.id}:${language}`} value={sample.source} label="Copy code example" /></div>
      <Tabs label="Example language" value={language} onValueChange={setLanguage} items={operation.samples.map(item => ({value: item.label, label: item.label}))} />
      <pre className="docs-code" tabIndex={0}><code>{sample.source}</code></pre>
    </section>}
    {parameters.length > 0 && <section className="docs-section"><h2>Parameters</h2><div className="docs-field-list">{parameters.map(parameter => <div className="docs-field" key={`${parameter.in}:${parameter.name}`}><div><code>{parameter.name}</code>{parameter.required && <span className="docs-required">required</span>}<span className="docs-type">{parameter.in} · {typeLabel(document, parameter.schema)}</span></div>{parameter.description && <p>{parameter.description}</p>}</div>)}</div></section>}
    {body && <section className="docs-section"><h2>Request body</h2><SchemaDefinition document={document} input={body} /></section>}
    <section className="docs-section"><h2>Responses</h2><div className="docs-responses">{Object.entries(operation.responses).map(([status, response]) => { const schema = response.content?.['application/json']?.schema; return <details key={status} open={status.startsWith('2')}><summary><code>{status}</code><span>{response.description}</span></summary>{schema && <SchemaDefinition document={document} input={schema} />}</details> })}</div></section>
  </article>
}

export function DocsPage() {
  const query = useQuery<Document>({queryKey: ['public-openapi'], queryFn: async ({signal}) => { const response = await fetch('/openapi.json', {signal}); if (!response.ok) throw new Error('API definition could not be loaded.'); return response.json() }})
  const all = useMemo(() => operations(query.data), [query.data])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(() => window.location.hash.slice(1))
  useEffect(() => { const change = () => setSelected(window.location.hash.slice(1)); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change) }, [])
  useEffect(() => { if (all.length && !all.some(operation => operation.id === selected)) { const id = all.find(operation => operation.id === 'sendEmail')?.id ?? all[0].id; history.replaceState(null, '', `#${id}`); setSelected(id) } }, [all, selected])
  const filtered = all.filter(operation => `${operation.id} ${operation.summary} ${operation.path} ${operation.tag}`.toLowerCase().includes(search.toLowerCase()))
  const groups = [...new Set(filtered.map(operation => operation.tag))]
  const current = all.find(operation => operation.id === selected)
  return <div className="docs-page">
    <header className="docs-header"><Link className="docs-brand" to="/"><strong>OpenSend</strong><span>Docs</span></Link><nav aria-label="Documentation links"><a href="/docs.md">Markdown</a><a href="/openapi.json">OpenAPI</a><a href="https://www.npmjs.com/package/opensend-js">TypeScript SDK</a><Link to="/">Dashboard</Link></nav></header>
    <div className="docs-layout">
      <aside className="docs-sidebar"><Input type="search" aria-label="Search API documentation" placeholder="Search API" value={search} onChange={event => setSearch(event.target.value)} />
        <nav aria-label="API operations">{query.isPending ? <div className="stack"><SkeletonText /><SkeletonText /><SkeletonText /></div> : groups.map(group => <div className="docs-nav-group" key={group}><h2>{group}</h2>{filtered.filter(operation => operation.tag === group).map(operation => <a key={operation.id} href={`#${operation.id}`} data-active={operation.id === selected || undefined}><span data-method={operation.method}>{operation.method}</span><span>{operation.summary}</span></a>)}</div>)}</nav>
      </aside>
      <main className="docs-main">{query.isError ? <ErrorState error={query.error} onRetry={() => query.refetch()} /> : !current ? <EmptyState title={query.isPending ? 'Loading API documentation…' : 'No matching operation'} /> : <OperationPage document={query.data!} operation={current} />}</main>
    </div>
  </div>
}
