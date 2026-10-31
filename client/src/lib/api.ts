export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let lastResponseTime: string | null = null;
const listeners = new Set<(t: string) => void>();
export const onResponseTime = (fn: (t: string) => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const getLastResponseTime = () => lastResponseTime;

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const time = res.headers.get('X-Response-Time');
  if (time) {
    lastResponseTime = time;
    listeners.forEach((l) => l(time));
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(res.status, data?.error ?? 'Request failed');
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export interface Page<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
