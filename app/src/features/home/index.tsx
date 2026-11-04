import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '../../components/ui'
import { ThemeToggle } from '../../components/ThemeToggle'
import { number, percent } from '../../lib/format'
import './home.css'

// Placeholder figures until a public stats endpoint exists; replace this object with its response.
export const publicStats = {
  emailsSent: 2_173_418,
  sendsPerMinute: 48,
  deliveryRate: 0.9941,
  medianSendLatencyMs: 182,
  regions: ['us-east-1', 'us-east-2', 'eu-west-1'],
  uptime: 0.9998,
  hourlyVolume: [38, 31, 27, 22, 19, 21, 28, 41, 57, 66, 72, 78, 81, 76, 74, 79, 83, 88, 71, 64, 58, 52, 47, 61],
}

const capabilities = [
  ['Send', 'Transactional and marketing email from one API.', 'POST /v1/emails/send'],
  ['Receive', 'Inbound addresses on your domains, parsed and posted to webhooks.', 'POST /v1/inbound/addresses'],
  ['Reply', 'Answer a received message from the address it was sent to.', 'POST /v1/inbound/threads/:id/reply'],
  ['Thread', 'Messages grouped into conversations with full history.', 'GET /v1/inbound/threads/:id'],
] as const

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

function useLiveCount(target: number, perMinute: number) {
  const [value, setValue] = useState(() => reducedMotion() ? target : Math.round(target * 0.985))
  useEffect(() => {
    if (reducedMotion()) return
    const from = Math.round(target * 0.985), started = performance.now(), duration = 1400
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - started) / duration)
      setValue(Math.round(from + (target - from) * (1 - (1 - t) ** 3)))
      if (t < 1) frame = requestAnimationFrame(step)
    })
    const perTick = perMinute / 30
    const ticker = window.setInterval(() => setValue(current => current + Math.max(1, Math.round(perTick * (0.5 + Math.random())))), 2000)
    return () => { cancelAnimationFrame(frame); window.clearInterval(ticker) }
  }, [target, perMinute])
  return value
}

function VolumeBars({ values }: { values: readonly number[] }) {
  const max = Math.max(...values)
  return <svg className="home-volume" viewBox={`0 0 ${values.length * 6} 40`} preserveAspectRatio="none" aria-hidden="true">
    {values.map((value, index) => <rect key={index} className={index === values.length - 1 ? 'chart-bar chart-bar--active' : 'chart-bar'} x={index * 6} y={40 - (value / max) * 40} width={4} height={(value / max) * 40} rx={1} />)}
  </svg>
}

export function HomePage({ onSignIn, busy, notice }: { onSignIn: () => void; busy: boolean; notice?: ReactNode }) {
  const sent = useLiveCount(publicStats.emailsSent, publicStats.sendsPerMinute)
  useEffect(() => { document.title = 'opensend · Email sending infrastructure' }, [])
  return <div className="home-page">
    <header className="home-header">
      <a className="wordmark" href="/" aria-label="opensend home"><span className="wordmark-square" aria-hidden="true" />opensend</a>
      <nav className="home-nav" aria-label="Site">
        <a href="/docs">Docs</a>
        <ThemeToggle />
        <Button onClick={onSignIn} disabled={busy}>Sign in</Button>
      </nav>
    </header>
    <main className="home-main">
      <section className="home-hero">
        <h1>Email sending infrastructure done right.</h1>
        <p>Send, receive, reply and thread email through one API, on Amazon SES.</p>
        <div className="home-actions">
          <Button variant="primary" loading={busy} onClick={onSignIn}>Get started with Google</Button>
          <a className="ui-button ui-button--secondary ui-button--md" href="/docs">Read the docs <ArrowUpRight size={16} aria-hidden="true" /></a>
        </div>
        {notice}
      </section>
      <section className="home-board" aria-label="Sending stats">
        <div className="home-counter">
          <div>
            <div className="home-counter-label muted"><span className="home-live" aria-hidden="true" />Emails sent</div>
            <div className="home-counter-value">{number(sent)}</div>
          </div>
          <div className="home-counter-chart">
            <VolumeBars values={publicStats.hourlyVolume} />
            <div className="muted cell-caption">Last 24 hours · UTC</div>
          </div>
        </div>
        <div className="metrics-grid">
          <Stat title="Delivery rate" value={percent(publicStats.deliveryRate)} note="Accepted by receiving servers" tone="success" />
          <Stat title="Median send latency" value={`${number(publicStats.medianSendLatencyMs)} ms`} note="API request to SES handoff" />
          <Stat title="Regions" value={String(publicStats.regions.length)} note={publicStats.regions.map((region, index) => <span key={region}>{index > 0 && ' · '}<span className="nowrap">{region}</span></span>)} />
          <Stat title="API uptime" value={percent(publicStats.uptime)} note="Rolling 90 days" />
        </div>
      </section>
      <section className="home-capabilities" aria-label="Capabilities">
        {capabilities.map(([name, line, endpoint]) => <div className="home-capability" key={name}>
          <h2>{name}</h2>
          <p className="muted">{line}</p>
          <code>{endpoint}</code>
        </div>)}
      </section>
    </main>
    <footer className="home-footer muted">
      <span>opensend</span>
      <nav aria-label="Developer links"><a href="/docs">Docs</a><a href="/openapi.json">OpenAPI</a><a href="https://www.npmjs.com/package/opensend-js">TypeScript SDK</a></nav>
    </footer>
  </div>
}

function Stat({ title, value, note, tone }: { title: string; value: string; note: ReactNode; tone?: string }) {
  return <div className="metric"><div className="muted">{title}</div><div className={`metric-value ${tone ? `text-${tone}` : ''}`}>{value}</div><div className="muted cell-caption">{note}</div></div>
}
