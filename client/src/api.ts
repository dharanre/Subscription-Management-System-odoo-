export const UNAUTHORIZED_EVENT = 'bl:unauthorized';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'unknown', err instanceof Error ? err.message : 'Something went wrong');
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check that it is running, then try again.');
  }
  if (res.status === 204) return undefined as T;

  const data = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; fields?: Record<string, string> };
  } | null;
  if (!res.ok) {
    // A session that ended mid-use sends the user back to the sign-in screen.
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'error',
      data?.error?.message ?? `The request failed (${res.status}).`,
      data?.error?.fields ?? {},
    );
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
};

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export type Role = 'admin' | 'staff' | 'customer';

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

export interface Account extends User {
  isActive: boolean;
  isDemo: boolean;
  createdAt: string;
}
