import { SESv2Client } from '@aws-sdk/client-sesv2';
import type { HttpHandlerOptions, HttpRequest, HttpResponse, RequestHandler } from '@smithy/types';
import type { Runtime } from '../core.js';

export interface SimulatedSesOptions {
  latencyMs?: number;
  maxSendRate?: number;
  // In-memory, per-client sequence for adapter tests only; never deployment
  // configuration. A fresh simulatedSes client starts a fresh handler.
  outcomes?: readonly ('accept' | 'throttle' | 'reject' | 'timeout')[];
}

export function createSimulatedSesHandler(options: SimulatedSesOptions = {}): RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions> {
  const latencyMs = options.latencyMs ?? 200;
  const maxSendRate = options.maxSendRate ?? 1000;
  const outcomes = [...(options.outcomes ?? [])];
  let sent = 0;
  const response = (statusCode: number, body: Record<string, unknown>, errorType?: string) => ({ response: {
    statusCode,
    headers: { 'content-type': 'application/json', 'x-amzn-requestid': crypto.randomUUID(), ...(errorType ? { 'x-amzn-errortype': errorType } : {}) },
    body: new TextEncoder().encode(JSON.stringify(body)),
  } });
  return {
    async handle(request, handlerOptions) {
      if (handlerOptions?.abortSignal?.aborted) throw Object.assign(new Error('Simulated SES request aborted.'), { name: 'AbortError' });
      // Fail closed even if this handler is accidentally attached to another endpoint.
      if (request.protocol !== 'https:' || request.hostname !== 'ses-simulator.invalid') throw new Error('Unsupported simulated SES endpoint.');
      if (request.method === 'GET' && request.path === '/v2/email/account') {
        return response(200, { SendingEnabled: true, SendQuota: { MaxSendRate: maxSendRate, Max24HourSend: -1, SentLast24Hours: 0 } });
      }
      if (request.method !== 'POST' || request.path !== '/v2/email/outbound-emails') throw new Error('Unsupported simulated SES operation.');
      // Consume before waiting so concurrent requests have deterministic outcomes.
      const outcome = outcomes[sent++] ?? 'accept';
      if (latencyMs > 0) await new Promise(resolve => setTimeout(resolve, latencyMs));
      if (handlerOptions?.abortSignal?.aborted) throw Object.assign(new Error('Simulated SES request aborted.'), { name: 'AbortError' });
      if (outcome === 'timeout') throw Object.assign(new Error('Simulated SES request timed out.'), { name: 'TimeoutError' });
      if (outcome === 'throttle') return response(429, { message: 'Simulated SES throttling.' }, 'TooManyRequestsException');
      if (outcome === 'reject') return response(400, { message: 'Simulated SES rejection.' }, 'MessageRejected');
      return response(200, { MessageId: `sim_${crypto.randomUUID()}` });
    },
  };
}

// Same invocation-local client lifetime as the live SDK transport.
const clients = new WeakMap<Runtime, Map<string, SESv2Client>>();
export function simulatedSes(runtime: Runtime, region: string): SESv2Client {
  let regions = clients.get(runtime);
  if (!regions) { regions = new Map(); clients.set(runtime, regions); }
  const existing = regions.get(region);
  if (existing) return existing;
  const client = new SESv2Client({
    region,
    credentials: { accessKeyId: 'SIMULATED_SES_ACCESS_KEY', secretAccessKey: 'simulated-ses-secret-not-an-aws-credential' },
    endpoint: 'https://ses-simulator.invalid',
    maxAttempts: 1,
    requestHandler: createSimulatedSesHandler(runtime.config.simulatedSes),
  });
  regions.set(region, client);
  return client;
}
