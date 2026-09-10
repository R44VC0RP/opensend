import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { useApi, useRegion } from '../../data/context';
import { templateApi } from '../../data/templates';
import {
  Alert,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  StatusBadge,
} from '../../components/ui';
import { EmailPreview } from '../../components/EmailPreview';
import './templates.css';

export function TemplatesPage() {
  const api = useApi(),
    navigate = useNavigate(),
    [name, setName] = useState(''),
    [cursor, setCursor] = useState<string>();
  const client = useMemo(() => templateApi(api.environment), [api.environment]);
  const query = useQuery({
    queryKey: ['templates', api.environment, cursor],
    queryFn: ({ signal }) =>
      api.mode === 'demo' ? Promise.resolve({ data: [], nextCursor: null }) : client.list(cursor, signal),
  });
  const create = useMutation({
    mutationFn: () => client.create(name),
    onSuccess: (row) => navigate(`/templates/${row.id}?environment=${api.environment}`),
  });
  return (
    <div className="stack">
      <PageHeader title="Templates" />
      <form
        className="cluster template-create"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Template name" htmlFor="template-name">
          <Input
            id="template-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="Summer collection"
          />
        </Field>
        <Button variant="primary" type="submit" disabled={!name.trim() || create.isPending || api.mode === 'demo'}>
          Create template
        </Button>
      </form>
      {create.error && <ErrorState error={create.error} />}
      {query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <DataTable
          rows={query.data?.data ?? []}
          rowKey={(r) => r.id}
          loading={query.isPending}
          onRowClick={(r) => navigate(`/templates/${r.id}?environment=${api.environment}`)}
          columns={[
            { key: 'name', label: 'Template', render: (r) => r.name },
            { key: 'kind', label: 'Type', render: (r) => r.kind },
            { key: 'revision', label: 'Revision', render: (r) => r.revision },
            {
              key: 'status',
              label: 'Status',
              render: (r) => <StatusBadge status={r.publishedVersionId ? 'published' : 'draft'} />,
            },
          ]}
          empty={
            <EmptyState
              title="Create your first template"
              description="Describe the email to your authoring agent, then preview and publish it here."
            />
          }
        />
      )}
      <div className="cluster">
        {cursor && <Button onClick={() => setCursor(undefined)}>First page</Button>}
        {query.data?.nextCursor && <Button onClick={() => setCursor(query.data!.nextCursor!)}>Next page</Button>}
      </div>
    </div>
  );
}
export function TemplateDetailPage() {
  const { id = '' } = useParams(),
    api = useApi(),
    { regionId } = useRegion(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const client = useMemo(() => templateApi(api.environment), [api.environment]);
  const [prompt, setPrompt] = useState(''),
    [versionId, setVersionId] = useState(''),
    [mobile, setMobile] = useState(false),
    [confirm, setConfirm] = useState(false),
    [legacy, setLegacy] = useState(false),
    [versionCursor, setVersionCursor] = useState<string>();
  const key = ['template', api.environment, id];
  const template = useQuery({ queryKey: key, queryFn: ({ signal }) => client.get(id, signal), refetchInterval: 5000 });
  const versions = useQuery({
    queryKey: [...key, 'versions', versionCursor],
    queryFn: ({ signal }) => client.versions(id, versionCursor, signal),
    refetchInterval: 5000,
  });
  const selected = versionId || versions.data?.data[0]?.id;
  const artifact = useQuery({
    queryKey: [...key, 'artifact', selected],
    enabled: !!selected,
    queryFn: ({ signal }) => client.artifact(id, selected!, signal),
    refetchInterval: 5000,
  });
  const session = useQuery({
    queryKey: [...key, 'session'],
    queryFn: ({ signal }) => client.session(id, signal),
    refetchInterval: 5000,
  });
  const messages = useQuery({
    queryKey: [...key, 'messages'],
    enabled: !!session.data?.sessionId,
    queryFn: ({ signal }) => client.messages(id, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const send = useMutation({
    mutationFn: (input: { prompt: string; messageId: string }) => client.prompt(id, input.prompt, input.messageId),
    onSuccess: () => {
      setPrompt('');
      void session.refetch();
    },
  });
  const interrupt = useMutation({ mutationFn: () => client.interrupt(id), onSuccess: () => session.refetch() });
  const publish = useMutation({
    mutationFn: () => client.publish(id, selected!, regionId, legacy),
    onSuccess: () => {
      setConfirm(false);
      void cache.invalidateQueries({ queryKey: key });
    },
  });
  const campaign = useMutation({
    mutationFn: () => client.campaign(template.data!, artifact.data!.version),
    onSuccess: (r) => navigate(`/campaigns/${r.id}/edit?environment=${api.environment}`),
  });
  if (template.error) return <ErrorState error={template.error} onRetry={() => template.refetch()} />;
  return (
    <div className="stack">
      <PageHeader
        title={template.data?.name ?? 'Template'}
        backTo={`/templates?environment=${api.environment}`}
        actions={
          <div className="cluster">
            {artifact.data?.version.status === 'published' && template.data?.kind === 'marketing' && (
              <Button onClick={() => campaign.mutate()} disabled={campaign.isPending}>
                Create campaign
              </Button>
            )}
            <Button
              variant="primary"
              disabled={
                !artifact.data?.version.validation.valid ||
                artifact.data.version.status === 'publishing' ||
                artifact.data.version.status === 'published'
              }
              onClick={() => setConfirm(true)}
            >
              Publish
            </Button>
          </div>
        }
      />
      {[versions.error, artifact.error, session.error, send.error, interrupt.error, publish.error, campaign.error]
        .filter(Boolean)
        .map((error, i) => (
          <ErrorState key={i} error={error} />
        ))}
      <div className="template-workspace">
        <section className="template-conversation stack" aria-label="Authoring conversation">
          <h2>Author</h2>
          {session.data && !session.data.configured && (
            <Alert tone="info">
              Connect your OpenCode server in the installation configuration to begin authoring.
            </Alert>
          )}
          {session.data?.errorCode && (
            <Alert tone="warning">
              Authoring request {session.data.inputStatus}: {session.data.errorCode}.{' '}
              {session.data.inputStatus === 'failed'
                ? 'Resubmit your instructions after resolving the connection.'
                : 'The worker will retry.'}
            </Alert>
          )}
          <div className="template-messages" aria-live="polite">
            {messages.data?.data.map((m) => (
              <article key={m.id}>
                <span className="muted">{m.role}</span>
                <p>{m.text}</p>
              </article>
            ))}
            {!messages.data?.data.length && (
              <p className="muted">
                Describe the offer, audience, tone, and imagery. Your agent saves drafts here for review.
              </p>
            )}
          </div>
          {messages.error && <ErrorState error={messages.error} onRetry={() => messages.refetch()} />}
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate({ prompt, messageId: `msg_${crypto.randomUUID().replaceAll('-', '')}` });
            }}
          >
            <Field label="Instructions" htmlFor="template-prompt">
              <textarea
                id="template-prompt"
                className="template-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                maxLength={20000}
                rows={5}
                placeholder="Create a campaign introducing our summer collection…"
              />
            </Field>
            <div className="cluster">
              <Button
                type="submit"
                variant="primary"
                disabled={!prompt.trim() || !session.data?.configured || send.isPending}
              >
                Send instructions
              </Button>
              {session.data?.sessionId && (
                <Button onClick={() => interrupt.mutate()} disabled={interrupt.isPending}>
                  Stop author
                </Button>
              )}
            </div>
          </form>
        </section>
        <section className="template-preview stack" aria-label="Template preview">
          <div className="cluster">
            <Select
              aria-label="Template version"
              value={selected ?? ''}
              onValueChange={setVersionId}
              options={(versions.data?.data ?? []).map((v) => ({
                value: v.id,
                label: `Revision ${v.revision} · ${v.status}`,
              }))}
            />
            <Button onClick={() => setMobile(!mobile)}>{mobile ? 'Desktop preview' : 'Mobile preview'}</Button>
          </div>
          <div className="cluster">
            {versionCursor && (
              <Button
                onClick={() => {
                  setVersionCursor(undefined);
                  setVersionId('');
                }}
              >
                Latest versions
              </Button>
            )}
            {versions.data?.nextCursor && (
              <Button
                onClick={() => {
                  setVersionCursor(versions.data!.nextCursor!);
                  setVersionId('');
                }}
              >
                Older versions
              </Button>
            )}
          </div>
          {artifact.data ? (
            <>
              <div className="cluster">
                <StatusBadge status={artifact.data.version.status} />
                <span className="muted">{(artifact.data.version.validation.bytes / 1024).toFixed(1)} KiB</span>
              </div>
              <strong>{artifact.data.artifact.subject}</strong>
              <p className="muted">{artifact.data.artifact.previewText}</p>
              {artifact.data.version.validation.errors.map((e) => (
                <Alert key={e} tone="warning">
                  {e}
                </Alert>
              ))}
              {artifact.data.version.errorCode && (
                <Alert tone="warning">
                  Publication failed: {artifact.data.version.errorCode}. Check configuration and retry.
                </Alert>
              )}
              <div className={mobile ? 'template-preview-mobile' : ''}>
                <EmailPreview
                  html={artifact.data.artifact.html}
                  title="Template email preview"
                  respectStyles
                  remoteImages
                />
              </div>
              <details>
                <summary>Plain text</summary>
                <pre className="template-text">{artifact.data.artifact.text}</pre>
              </details>
            </>
          ) : (
            <EmptyState
              title="Waiting for the first draft"
              description="Your preview appears when the author saves a version."
            />
          )}
        </section>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Publish this version?"
        description={`Publish revision ${artifact.data?.version.revision ?? ''} in ${regionId} (${api.environment ?? 'live'}). Existing campaigns retain their selected version.${legacy && artifact.data?.artifact.legacySesName ? ` Also replace legacy SES template ${artifact.data.artifact.legacySesName}.` : ''}`}
        confirmLabel="Publish"
        onConfirm={() => publish.mutate()}
        pending={publish.isPending}
      />
      {artifact.data?.artifact.legacySesName && (
        <Checkbox
          label={`Also update legacy SES template ${artifact.data.artifact.legacySesName}`}
          checked={legacy}
          onCheckedChange={setLegacy}
        />
      )}
    </div>
  );
}
