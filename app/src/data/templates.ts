import { request } from './live';
export interface LibraryTemplate {
  id: string;
  name: string;
  kind: 'marketing' | 'automation';
  revision: number;
  publishedVersionId: string | null;
}
export interface TemplateVersion {
  id: string;
  templateId: string;
  revision: number;
  subject: string;
  status: 'draft' | 'publishing' | 'published' | 'failed';
  region: string | null;
  errorCode: string | null;
  validation: { valid: boolean; errors: string[]; bytes: number };
}
export interface TemplateArtifact {
  subject: string;
  previewText: string;
  html: string;
  text: string;
  source: Record<string, string>;
  dependencies: Record<string, string>;
  fields: { name: string; required: boolean; sample: string; default?: string }[];
  legacySesName?: string;
}
export function templateApi(environment: 'live' | 'test' = 'live') {
  const call = <T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
    request<T>(`/v1${path}`, { environment, method, body, signal });
  const root = (id: string) => `/template-library/${encodeURIComponent(id)}`;
  return {
    list: (cursor?: string, signal?: AbortSignal) =>
      call<{ data: LibraryTemplate[]; nextCursor: string | null }>(
        `/template-library?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    create: (name: string) => call<LibraryTemplate>('/template-library', 'POST', { name }),
    get: (id: string, signal?: AbortSignal) => call<LibraryTemplate>(root(id), 'GET', undefined, signal),
    versions: (id: string, cursor?: string, signal?: AbortSignal) =>
      call<{ data: TemplateVersion[]; nextCursor: string | null }>(
        `${root(id)}/versions?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        'GET',
        undefined,
        signal,
      ),
    artifact: (id: string, version: string, signal?: AbortSignal) =>
      call<{ version: TemplateVersion; artifact: TemplateArtifact }>(
        `${root(id)}/versions/${encodeURIComponent(version)}`,
        'GET',
        undefined,
        signal,
      ),
    publish: (id: string, version: string, region: string, updateLegacy: boolean) =>
      call<TemplateVersion>(`${root(id)}/versions/${encodeURIComponent(version)}/publish`, 'POST', {
        region,
        updateLegacy,
      }),
    session: (id: string, signal?: AbortSignal) =>
      call<{
        configured: boolean;
        inputStatus?: string | null;
        errorCode?: string | null;
        sessionId: string | null;
        expiresAt: string | null;
      }>(`${root(id)}/authoring`, 'GET', undefined, signal),
    messages: (id: string, signal?: AbortSignal) =>
      call<{ data: { id: string; role: string; text: string }[] }>(
        `${root(id)}/authoring/messages`,
        'GET',
        undefined,
        signal,
      ),
    prompt: (id: string, prompt: string, messageId: string) =>
      call(`${root(id)}/authoring`, 'POST', { prompt, messageId }),
    interrupt: (id: string) => call(`${root(id)}/authoring/interrupt`, 'POST'),
    campaign: (template: LibraryTemplate, version: TemplateVersion) =>
      call<{ id: string }>('/campaigns', 'POST', {
        name: template.name,
        subject: version.subject,
        region: version.region,
        templateVersionId: version.id,
      }),
  };
}
