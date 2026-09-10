import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from '../../data/context';
import { progressApi, type CampaignProgress as Progress } from '../../data/campaign-progress';
import {
  Alert,
  Button,
  ConfirmDialog,
  DataTable,
  ErrorState,
  SectionHeader,
  Select,
  StatusBadge,
} from '../../components/ui';
import { number, percent } from '../../lib/format';
import './progress.css';
export function CampaignProgress({ id }: { id: string }) {
  const api = useApi(),
    client = useMemo(() => progressApi(api.environment), [api.environment]);
  const [cursor, setCursor] = useState<string>(),
    [status, setStatus] = useState(''),
    [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ['campaign-progress', api.environment, id],
    enabled: api.mode !== 'demo',
    queryFn: ({ signal }) => client.get(id, signal),
    refetchInterval: (q) =>
      ['sending', 'scheduled', 'draft', 'reviewed'].includes(q.state.data?.status ?? '') ? 5000 : 30000,
  });
  const recipients = useQuery({
    queryKey: ['campaign-recipients', api.environment, id, cursor, status],
    enabled: !!query.data?.preparation && query.data.preparation.status !== 'preparing',
    queryFn: ({ signal }) => client.recipients(id, cursor, status, signal),
    refetchInterval: query.data?.status === 'sending' ? 5000 : false,
  });
  const resume = useMutation({
    mutationFn: () => client.resume(id),
    onSuccess: () => {
      void query.refetch();
    },
  });
  const cancel = useMutation({
    mutationFn: () => client.cancel(id),
    onSuccess: () => {
      setConfirm(false);
      void query.refetch();
    },
  });
  if (api.mode === 'demo') return null;
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data) return null;
  const p = query.data,
    r = p.preparation,
    accepted = p.outcomes.accepted ?? 0,
    delivered = p.outcomes.delivered ?? 0;
  const denominator = r?.eligible ?? p.total,
    finished = Math.max(0, denominator - p.remaining);
  return (
    <section className="stack campaign-progress" aria-label="Campaign progress">
      <SectionHeader
        title={r?.status === 'preparing' ? 'Preparing recipients' : 'Send progress'}
        actions={
          ['sending', 'scheduled'].includes(p.status) ? (
            <Button onClick={() => setConfirm(true)}>Cancel remaining sends</Button>
          ) : undefined
        }
      />
      {r?.status === 'preparing' ? (
        <>
          <progress max={Math.max(1, r.eligible)} value={r.prepared} aria-label="Recipients validated" />
          <p>
            {number(r.prepared)} of {number(r.eligible)} recipients validated
          </p>
        </>
      ) : (
        <>
          <progress max={Math.max(1, denominator)} value={finished} aria-label="Recipients processed" />
          <div className="cluster">
            <strong>
              {number(finished)} / {number(denominator)} processed
            </strong>
            <span className="muted">{number(p.remaining)} remaining</span>
            {p.perSecond !== null && <span className="muted">{p.perSecond.toFixed(1)} / second</span>}
            {p.estimatedSeconds !== null && (
              <span className="muted">About {Math.ceil(p.estimatedSeconds / 60)} minutes remaining</span>
            )}
          </div>
        </>
      )}
      {r?.errorCode && (
        <Alert tone="warning">
          Preparation or expansion stopped: {r.errorCode}.{' '}
          {['sending', 'scheduled'].includes(p.status) ? (
            <Button onClick={() => resume.mutate()} disabled={resume.isPending}>
              Resume remaining recipients
            </Button>
          ) : (
            'Resolve the issue and prepare the campaign again.'
          )}
        </Alert>
      )}
      <dl className="campaign-progress-counts">
        {[
          ['Queued', p.statuses.queued ?? 0],
          ['Processing', p.statuses.attempting ?? 0],
          ['Accepted by SES', accepted],
          ['Skipped', (p.statuses.suppressed ?? 0) + (r?.suppressed ?? 0) + (r?.unsubscribed ?? 0)],
          ['Failed', (p.statuses.rejected ?? 0) + (p.statuses.rendering_failed ?? 0)],
          ['Acceptance uncertain', p.statuses.acceptance_unknown ?? 0],
          ['Canceled', p.statuses.canceled ?? 0],
          ...(api.environment === 'test' ? [['Simulated', p.statuses.simulated ?? 0]] : []),
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>{number(Number(value))}</dd>
          </div>
        ))}
      </dl>
      <SectionHeader title="Delivery and engagement" />
      <dl className="campaign-progress-counts">
        {[
          ['Delivered', delivered, accepted],
          ['Bounced', p.outcomes.bounced ?? 0, accepted],
          ['Complained', p.outcomes.complained ?? 0, accepted],
          ['Opened', p.outcomes.opened ?? 0, delivered],
          ['Clicked', p.outcomes.clicked ?? 0, delivered],
          ['Unsubscribed', p.outcomes.unsubscribed ?? 0, delivered],
        ].map(([label, value, total]) => (
          <div key={String(label)}>
            <dt>{label}</dt>
            <dd>
              {number(Number(value))}{' '}
              <span className="muted">{total ? percent(Number(value) / Number(total)) : '—'}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="muted">
        Delivery, bounce, and complaint rates use accepted messages. Open and click rates use delivered messages.
        Engagement is observed activity. Delivery feedback can arrive after sending finishes.
      </p>
      {!!p.daily.length && <OutcomeChart data={p} />}
      {r && (
        <>
          <SectionHeader title="Recipients" />
          <Select
            aria-label="Filter recipients"
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setCursor(undefined);
            }}
            options={[
              '',
              'queued',
              'attempting',
              'delivered',
              'bounced',
              'complained',
              'rejected',
              'rendering_failed',
              'acceptance_unknown',
              'suppressed',
              'unsubscribed',
              'canceled',
              'simulated',
            ].map((v) => ({ value: v, label: v || 'All recipients' }))}
          />
          {recipients.error ? (
            <ErrorState error={recipients.error} onRetry={() => recipients.refetch()} />
          ) : (
            <DataTable
              rows={recipients.data?.data ?? []}
              rowKey={(row) => row.contactId}
              columns={[
                { key: 'email', label: 'Recipient', render: (row) => row.email },
                {
                  key: 'status',
                  label: 'Status',
                  render: (row) => <StatusBadge status={row.status ?? row.exclusion ?? 'pending'} />,
                },
                { key: 'error', label: 'Details', render: (row) => row.errorCode ?? '—' },
              ]}
              loading={recipients.isPending}
            />
          )}
          <div className="cluster">
            {cursor && <Button onClick={() => setCursor(undefined)}>First page</Button>}
            {recipients.data?.nextCursor && (
              <Button onClick={() => setCursor(recipients.data!.nextCursor!)}>Next page</Button>
            )}
          </div>
        </>
      )}
      {resume.error && <ErrorState error={resume.error} />}
      {cancel.error && <ErrorState error={cancel.error} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Cancel remaining sends?"
        description="Queued recipients and future expansion will stop. Messages already accepted or being sent cannot be recalled."
        confirmLabel="Cancel remaining sends"
        onConfirm={() => cancel.mutate()}
        pending={cancel.isPending}
      />
    </section>
  );
}
function OutcomeChart({ data }: { data: Progress }) {
  const observed = [...new Set(data.daily.map((r) => r.day))].sort();
  const end = Date.parse(observed.at(-1)! + 'T00:00:00Z'),
    start = Math.max(Date.parse(observed[0] + 'T00:00:00Z'), end - 29 * 86400000);
  const days = Array.from({ length: Math.floor((end - start) / 86400000) + 1 }, (_, i) =>
    new Date(start + i * 86400000).toISOString().slice(0, 10),
  );
  const series = ['delivered', 'opened', 'clicked'],
    max = Math.max(
      1,
      ...data.daily.filter((r) => days.includes(r.day) && series.includes(r.outcome)).map((r) => r.count),
    );
  return (
    <figure className="campaign-outcome-chart">
      <figcaption>Daily delivery and engagement</figcaption>
      <svg viewBox="0 0 720 170" role="img" aria-label="Delivered, opened, and clicked messages by UTC day">
        <title>Daily email outcomes</title>
        {series.map((s, index) => (
          <polyline
            key={s}
            className={`outcome-series outcome-series-${index}`}
            fill="none"
            strokeWidth="2"
            points={days
              .map(
                (day, i) =>
                  `${20 + (i * 680) / Math.max(1, days.length - 1)},${140 - ((data.daily.find((r) => r.day === day && r.outcome === s)?.count ?? 0) * 120) / max}`,
              )
              .join(' ')}
          />
        ))}
        {series.flatMap((outcome, index) =>
          days.map((day, i) => {
            const value = data.daily.find((r) => r.day === day && r.outcome === outcome)?.count ?? 0;
            return (
              <circle
                key={`${outcome}:${day}`}
                className={`outcome-series outcome-series-${index}`}
                cx={20 + (i * 680) / Math.max(1, days.length - 1)}
                cy={140 - (value * 120) / max}
                r="3"
                fill="currentColor"
              >
                <title>{`${day}: ${number(value)} ${outcome}`}</title>
              </circle>
            );
          }),
        )}
        <text x="20" y="12">
          {number(max)}
        </text>
        <text x="20" y="163">
          {days[0]}
        </text>
        <text x="700" y="163" textAnchor="end">
          {days.at(-1)}
        </text>
      </svg>
      <div className="cluster">
        {series.map((s, i) => (
          <span key={s} className={`outcome-legend outcome-series-${i}`}>
            {s}
          </span>
        ))}
      </div>
    </figure>
  );
}
