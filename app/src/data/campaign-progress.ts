import { request } from './live';
export interface CampaignPreparation {
  id: string;
  campaignId: string;
  revision: number;
  status: string;
  matched: number;
  eligible: number;
  suppressed: number;
  unsubscribed: number;
  prepared: number;
  expanded: number;
  errorCode: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}
export interface CampaignProgress {
  campaignId: string;
  status: string;
  preparation: CampaignPreparation | null;
  total: number;
  statuses: Record<string, number>;
  outcomes: Record<string, number>;
  daily: { day: string; outcome: string; count: number }[];
  remaining: number;
  perSecond: number | null;
  estimatedSeconds: number | null;
  updatedAt: string;
}
export interface CampaignRecipient {
  contactId: string;
  email: string;
  name: string | null;
  eligible: boolean;
  exclusion: string | null;
  emailId: string | null;
  status: string | null;
  errorCode: string | null;
}
export const progressApi = (environment: 'live' | 'test' = 'live') => ({
  get: (id: string, signal?: AbortSignal) =>
    request<CampaignProgress>(`/v1/campaigns/${encodeURIComponent(id)}/progress`, { environment, signal }),
  recipients: (id: string, cursor?: string, status?: string, signal?: AbortSignal) =>
    request<{ data: CampaignRecipient[]; nextCursor: string | null }>(
      `/v1/campaigns/${encodeURIComponent(id)}/recipients?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}`,
      { environment, signal },
    ),
  resume: (id: string) =>
    request(`/v1/campaigns/${encodeURIComponent(id)}/resume-expansion`, { environment, method: 'POST' }),
  cancel: (id: string) => request(`/v1/campaigns/${encodeURIComponent(id)}/cancel`, { environment, method: 'POST' }),
});
