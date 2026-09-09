import { useState } from 'react'
import { CopyButton, Field, PageHeader, SectionHeader, Select } from '../../components/ui'
import './developer.css'

const accessOptions = [
  { value: 'test-read', label: 'Read only · test', scope: 'opensend:read offline_access', hint: 'Read test data without sending email.' },
  { value: 'test-manage', label: 'Full access · test', scope: 'opensend:read opensend:send opensend:manage offline_access', hint: 'Request management access in test mode. Email delivery is simulated.' },
  { value: 'live-read', label: 'Read only · live', scope: 'opensend:read opensend:live offline_access', hint: 'Read live data without sending email.' },
  { value: 'live-manage', label: 'Full access · live', scope: 'opensend:read opensend:send opensend:manage opensend:live offline_access', hint: 'Includes sending real email and changing live configuration.' },
]

export function DeveloperPage() {
  const [access, setAccess] = useState(accessOptions[0].value)
  const selected = accessOptions.find(option => option.value === access) ?? accessOptions[0]
  const serverUrl = new URL('/mcp', window.location.origin).href
  const configuration = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: { servers: { opensend: { type: 'remote', url: serverUrl, oauth: { scope: selected.scope } } } },
  }, null, 2)

  return <div className="stack developer-page">
    <PageHeader title="Developer" />
    <section className="section stack" aria-label="MCP server">
      <SectionHeader title="MCP server" />
      <div className="developer-url"><code>{serverUrl}</code><CopyButton value={serverUrl} label="Copy MCP URL" /></div>
      <p className="muted developer-copy">Add this URL as a remote HTTP server in your MCP client. Authorization uses your dashboard’s Google login; no API key or local MCP process is needed.</p>
    </section>
    <section className="section stack" aria-label="OpenCode setup">
      <SectionHeader title="OpenCode" actions={<CopyButton key={access} value={configuration} label="Copy OpenCode configuration" />} />
      <div className="developer-access">
        <Field label="Requested access" htmlFor="developer-mcp-access" hint={selected.hint}>
          <Select id="developer-mcp-access" value={access} onValueChange={setAccess} options={accessOptions} />
        </Field>
      </div>
      <pre className="developer-code" tabIndex={0} aria-label="OpenCode configuration"><code>{configuration}</code></pre>
      <ol className="developer-steps">
        <li>Merge this entry into your project or global <code>opencode.json</code>. Keep your existing servers and settings.</li>
        <li>Open <code>/mcps</code>, select <strong>opensend</strong>, then choose <strong>Sign in</strong>.</li>
        <li>Approve the requested access in your browser. A dashboard session in that browser profile skips Google sign-in.</li>
      </ol>
      <p className="muted developer-copy">Code Mode is enabled by default. Tools include typed input and output schemas. The access selection only changes the configuration above; reconnect and authorize after changing scopes.</p>
    </section>
  </div>
}
