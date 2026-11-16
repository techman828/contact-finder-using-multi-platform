/** Error thrown by providers. `code` is a short machine-readable reason shown in the UI. */
export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public extra: { status?: number; body?: unknown } = {}
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpResult {
  status: number;
  headers: Headers;
  body: any;
}

/**
 * fetch + JSON parse, with a timeout and exponential backoff on HTTP 429.
 * Never throws on HTTP error codes — providers map those to their own errors.
 */
export async function httpJson(
  url: string,
  { method = 'GET', headers = {}, body, timeoutMs = 30_000, retries = 2 }: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    retries?: number;
  } = {}
): Promise<HttpResult> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
    } catch (err: any) {
      const code = err?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      throw new ProviderError(code, `${code === 'TIMEOUT' ? 'Request timed out' : 'Network error'}: ${err?.message}`);
    }

    if (res.status === 429 && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }

    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _text: text.slice(0, 500) };
    }
    return { status: res.status, headers: res.headers, body: json };
  }
}

/** Normalise a phone number into a de-duplication key (digits only, keep a leading +). */
export const phoneKey = (p: string) => String(p).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
