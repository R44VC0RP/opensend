import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi, useApiQuery } from '../../data/context';
import { request } from '../../data/live';
import {
  Alert,
  Button,
  DataTable,
  ErrorState,
  Field,
  Input,
  PageHeader,
  SectionHeader,
  Select,
} from '../../components/ui';
import { parseCsv } from './csv';
import { number } from '../../lib/format';
interface Bulk {
  id: string;
  name: string;
  status: string;
  nextChunk: number;
  received: number;
  valid: number;
  errors: number;
  imported: number;
  errorCode: string | null;
}
interface Sync {
  configured: boolean;
  status: string;
  scanned: number;
  imported: number;
  errors: number;
  errorCode: string | null;
  lastSuccessAt: string | null;
  nextAt: string | null;
}
export function AudienceSyncPage() {
  const api = useApi(),
    [file, setFile] = useState<File>(),
    [rows, setRows] = useState<string[][]>([]),
    [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [listId, setListId] = useState(''),
    [importId, setImportId] = useState(() => new URLSearchParams(window.location.search).get('import') ?? ''),
    [error, setError] = useState(''),
    [uploaded, setUploaded] = useState(0),
    [cursor, setCursor] = useState<string>();
  const call = useMemo(
    () =>
      <T,>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
        request<T>(`/v1${path}`, { environment: api.environment, method, body, signal }),
    [api.environment],
  );
  const lists = useApiQuery(['sync-lists'], (api, signal) => api.lists.list({ pageSize: 100 }, signal));
  const sync = useQuery({
    queryKey: ['audience-sync', api.environment],
    enabled: api.mode !== 'demo',
    queryFn: ({ signal }) => call<Sync>('/audience-sync', 'GET', undefined, signal),
    refetchInterval: 5000,
  });
  const refresh = useMutation({ mutationFn: () => call('/audience-sync', 'POST'), onSuccess: () => sync.refetch() });
  const imported = useQuery({
    queryKey: ['bulk-import', api.environment, importId],
    enabled: !!importId && api.mode !== 'demo',
    queryFn: ({ signal }) =>
      call<Bulk>(`/bulk-contact-imports/${encodeURIComponent(importId)}`, 'GET', undefined, signal),
    refetchInterval: 5000,
  });
  const preview = useQuery({
    queryKey: ['bulk-import-rows', api.environment, importId, cursor],
    enabled: !!importId,
    queryFn: ({ signal }) =>
      call<{
        data: { row: number; email: string | null; name: string | null; error: string | null }[];
        nextCursor: string | null;
      }>(
        `/bulk-contact-imports/${encodeURIComponent(importId)}/rows?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
  });
  async function choose(next?: File) {
    setError('');
    setFile(next);
    setRows([]);
    if (!next) return;
    try {
      if (next.size > 32 * 1024 * 1024) throw new Error('Choose a CSV smaller than 32 MiB.');
      const parsed = parseCsv(await next.text());
      if (parsed.length > 250001) throw new Error('Use at most 250,000 contact rows.');
      if (parsed[0].length > 100) throw new Error('Use at most 100 columns.');
      const headers = parsed[0].map((v) => v.trim());
      if (new Set(headers).size !== headers.length || headers.some((v) => !v))
        throw new Error('Column headers must be unique and nonempty.');
      if (parsed.some((r) => r.length !== headers.length))
        throw new Error('Every row must match the header column count.');
      parsed[0] = headers;
      setRows(parsed);
      setEmail(headers.find((h) => h.toLowerCase() === 'email') ?? '');
      setName(headers.find((h) => ['firstname', 'first_name', 'name'].includes(h.toLowerCase())) ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to read CSV.');
    }
  }
  const upload = useMutation({
    mutationFn: async () => {
      const digest = await crypto.subtle.digest('SHA-256', await file!.arrayBuffer()),
        fingerprint = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
      const storageKey = `opensend-import:${api.environment}:${fingerprint}:${listId}:${email}:${name}`;
      const existing = localStorage.getItem(storageKey);
      let run = existing
        ? await call<Bulk>(`/bulk-contact-imports/${encodeURIComponent(existing)}`)
        : await call<Bulk>('/bulk-contact-imports', 'POST', { name: file!.name, listId });
      localStorage.setItem(storageKey, run.id);
      setImportId(run.id);
      const params = new URLSearchParams(window.location.search);
      params.set('import', run.id);
      window.history.replaceState(null, '', `?${params}`);
      if (run.status !== 'uploading') return run;
      for (let chunk = run.nextChunk; chunk * 1000 < rows.length - 1; chunk++) {
        const slice = rows
          .slice(1 + chunk * 1000, 1 + (chunk + 1) * 1000)
          .map((r) => ({
            email: r[rows[0].indexOf(email)],
            ...(name ? { name: r[rows[0].indexOf(name)] } : {}),
            properties: {
              ...Object.fromEntries(
                rows[0].flatMap((header, i) => (header !== email && header !== name ? [[header, r[i]]] : [])),
              ),
              ...(name ? { firstName: r[rows[0].indexOf(name)], firstname: r[rows[0].indexOf(name)] } : {}),
            },
          }));
        run = await call<Bulk>(`/bulk-contact-imports/${run.id}/chunks`, 'POST', { chunk, rows: slice });
        setUploaded(run.received);
      }
      return call<Bulk>(`/bulk-contact-imports/${run.id}/finalize`, 'POST');
    },
    onSuccess: () => {
      void imported.refetch();
      void preview.refetch();
    },
  });
  const commit = useMutation({
    mutationFn: () => call(`/bulk-contact-imports/${importId}/commit`, 'POST'),
    onSuccess: () => imported.refetch(),
  });
  return (
    <div className="stack">
      <PageHeader title="Audience sync" backTo="/contacts" />
      <SectionHeader
        title="CRM contacts"
        actions={
          <Button
            disabled={
              !sync.data?.configured ||
              sync.data.status === 'running' ||
              refresh.isPending ||
              api.environment === 'test'
            }
            onClick={() => refresh.mutate()}
          >
            Refresh now
          </Button>
        }
      />
      {sync.data && (
        <>
          <p>
            {sync.data.configured
              ? `Sync ${sync.data.status}`
              : 'Configure the read-only CRM connection and source view to enable recurring sync.'}
          </p>
          <div className="cluster">
            <span>{number(sync.data.scanned)} scanned</span>
            <span>{number(sync.data.imported)} imported</span>
            <span>{number(sync.data.errors)} errors</span>
          </div>
          {sync.data.lastSuccessAt && (
            <p className="muted">Last successful sync: {new Date(sync.data.lastSuccessAt).toLocaleString()}</p>
          )}
          {sync.data.errorCode && <Alert tone="warning">{sync.data.errorCode}</Alert>}
        </>
      )}
      {[sync.error, refresh.error, lists.error, imported.error, preview.error, upload.error, commit.error]
        .filter(Boolean)
        .map((e, i) => (
          <ErrorState key={i} error={e} />
        ))}
      <SectionHeader title="Import CSV" />
      <p className="muted">
        Upload up to 250,000 contacts. Imports update profiles and membership; existing consent and opt-outs remain
        effective. Reselect the same file and mapping to resume an interrupted upload.
      </p>
      <div className="form-grid">
        <Field label="Recipient list" htmlFor="bulk-list">
          <Select
            id="bulk-list"
            value={listId}
            onValueChange={setListId}
            options={(lists.data?.items ?? []).map((l) => ({ value: l.id, label: l.name }))}
          />
        </Field>
        <Field label="CSV file" htmlFor="bulk-file">
          <Input id="bulk-file" type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} />
        </Field>
      </div>
      {rows.length > 0 && (
        <div className="form-grid">
          <Field label="Email column" htmlFor="bulk-email">
            <Select
              id="bulk-email"
              value={email}
              onValueChange={setEmail}
              options={rows[0].map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <Field label="Name column" htmlFor="bulk-name">
            <Select
              id="bulk-name"
              value={name}
              onValueChange={setName}
              options={[{ value: '', label: 'No name column' }, ...rows[0].map((v) => ({ value: v, label: v }))]}
            />
          </Field>
        </div>
      )}
      {error && <Alert tone="warning">{error}</Alert>}
      <Button
        variant="primary"
        disabled={!file || !rows.length || !email || !listId || upload.isPending || api.mode === 'demo'}
        onClick={() => upload.mutate()}
      >
        Upload and preview
      </Button>
      {upload.isPending && (
        <p aria-live="polite">
          {number(uploaded)} of {number(rows.length - 1)} rows uploaded
        </p>
      )}
      {imported.data && (
        <>
          <SectionHeader title={imported.data.name} />
          <p>
            {imported.data.status} · {number(imported.data.valid)} valid · {number(imported.data.errors)} errors ·{' '}
            {number(imported.data.imported)} imported
          </p>
          {imported.data.errorCode && <Alert tone="warning">{imported.data.errorCode}</Alert>}
          <DataTable
            rows={preview.data?.data ?? []}
            rowKey={(r) => String(r.row)}
            columns={[
              { key: 'row', label: 'Row', render: (r) => r.row },
              { key: 'email', label: 'Email', render: (r) => r.email ?? '—' },
              { key: 'name', label: 'Name', render: (r) => r.name ?? '—' },
              { key: 'error', label: 'Error', render: (r) => r.error ?? '—' },
            ]}
          />
          <div className="cluster">
            {cursor && <Button onClick={() => setCursor(undefined)}>First page</Button>}
            {preview.data?.nextCursor && (
              <Button onClick={() => setCursor(preview.data!.nextCursor!)}>Next page</Button>
            )}
            {['preview', 'failed'].includes(imported.data.status) && (
              <Button variant="primary" disabled={commit.isPending} onClick={() => commit.mutate()}>
                Import {number(imported.data.valid)} valid contacts
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
