const API_BASE = '';

interface ApiOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  suppressErrorLog?: boolean;
  _retried?: boolean;
  /** Bypass the GET stale-while-revalidate micro-cache and always hit the network. */
  noCache?: boolean;
}

const GET_CACHE_TTL_MS = 5000;
const getCache = new Map<string, { data: unknown; expires: number }>();
const getInflight = new Map<string, Promise<unknown>>();

type AndroidAuthBridge = {
  getAuthSession?: () => string;
  saveAuthSession?: (session: string) => void;
  clearAuthSession?: () => void;
};

function getAndroidAuthBridge(): AndroidAuthBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as Window & { AndroidTracking?: AndroidAuthBridge }).AndroidTracking || null;
}

/** Mirror the WebView session into Android storage so it survives a full app close. */
export function persistAuthSessionToNative(): void {
  const bridge = getAndroidAuthBridge();
  if (!bridge?.saveAuthSession) return;
  try {
    const accessToken = localStorage.getItem('accessToken');
    const refreshToken = localStorage.getItem('refreshToken');
    const userRaw = localStorage.getItem('user');
    if (!accessToken || !refreshToken || !userRaw) return;
    bridge.saveAuthSession(JSON.stringify({
      accessToken,
      refreshToken,
      user: JSON.parse(userRaw),
      activeCompanyId: localStorage.getItem('activeCompanyId'),
      activeCompanyName: localStorage.getItem('activeCompanyName'),
    }));
  } catch {
    // The web session remains authoritative when no native bridge is available.
  }
}

/** Restore a native-backed session when Android recreated the WebView. */
export function restoreAuthSessionFromNative(): boolean {
  if (typeof window === 'undefined') return false;
  if (localStorage.getItem('accessToken') && localStorage.getItem('user')) return true;
  const bridge = getAndroidAuthBridge();
  if (!bridge?.getAuthSession) return false;
  try {
    const session = JSON.parse(bridge.getAuthSession()) as {
      accessToken?: string;
      refreshToken?: string;
      user?: unknown;
      activeCompanyId?: string | null;
      activeCompanyName?: string | null;
    };
    if (!session.accessToken || !session.refreshToken || !session.user) return false;
    localStorage.setItem('accessToken', session.accessToken);
    localStorage.setItem('refreshToken', session.refreshToken);
    localStorage.setItem('user', JSON.stringify(session.user));
    if (session.activeCompanyId) localStorage.setItem('activeCompanyId', session.activeCompanyId);
    if (session.activeCompanyName) localStorage.setItem('activeCompanyName', session.activeCompanyName);
    return true;
  } catch {
    return false;
  }
}

function clearNativeAuthSession(): void {
  try { getAndroidAuthBridge()?.clearAuthSession?.(); } catch {}
}

function cacheKey(path: string, token: string | null, companyId: string | null): string {
  const tokenTail = token ? token.slice(-12) : '';
  return `${path}::${companyId || ''}::${tokenTail}`;
}

function cloneData<T>(data: T): T {
  try {
    return JSON.parse(JSON.stringify(data)) as T;
  } catch {
    return data;
  }
}

export function clearApiCache(): void {
  getCache.clear();
  getInflight.clear();
}

function extractErrorMessage(data: unknown, status: number): string {
  if (!data) return `Request failed (${status})`;
  if (typeof data === 'string') {
    const trimmed = data.trim();

    if (trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html')) {
      const nextDataMatch = trimmed.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (nextDataMatch?.[1]) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          const message = nextData?.err?.message;
          if (typeof message === 'string' && message.trim()) return message;
        } catch {
        }
      }
      return `Server returned an HTML error page (${status})`;
    }

    return trimmed || `Request failed (${status})`;
  }
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  if (data instanceof Error) return data.message || `Request failed (${status})`;

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const direct = obj.message ?? obj.error ?? obj.details ?? obj.hint;
    if (typeof direct === 'string' && direct.trim()) return direct;
    if (direct && typeof direct === 'object') {
      try {
        return JSON.stringify(direct);
      } catch {
        return String(direct);
      }
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }

  return `Request failed (${status})`;
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    return res.json().catch(() => null);
  }

  const text = await res.text().catch(() => '');
  return text || null;
}

function syncAuthFromNativeTracking(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = (window as Window & {
    AndroidTracking?: { getAuthTokens?: () => string };
  }).AndroidTracking;
  if (!bridge?.getAuthTokens) return false;
  try {
    const nativeTokens = JSON.parse(bridge.getAuthTokens()) as {
      accessToken?: string;
      refreshToken?: string;
    };
    if (!nativeTokens.accessToken || nativeTokens.accessToken === localStorage.getItem('accessToken')) {
      return false;
    }
    localStorage.setItem('accessToken', nativeTokens.accessToken);
    if (nativeTokens.refreshToken) localStorage.setItem('refreshToken', nativeTokens.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();

  if (method !== 'GET') {
    try {
      return await apiCore<T>(path, options);
    } finally {
      clearApiCache();
    }
  }

  if (options.noCache || typeof window === 'undefined') {
    return apiCore<T>(path, options);
  }

  const token = localStorage.getItem('accessToken');
  const storedUserRaw = localStorage.getItem('user');
  let role: string | undefined;
  let partyId: string | null | undefined;
  if (storedUserRaw) {
    try {
      const user = JSON.parse(storedUserRaw) as { role?: string; party_id?: string | null };
      role = user.role;
      partyId = user.party_id;
    } catch {
    }
  }
  const isCompanySwitchRole = role === 'SUPER_ADMIN' || role === 'ADMIN';
  const companyId = isCompanySwitchRole
    ? (localStorage.getItem('activeCompanyId') || (role === 'ADMIN' ? partyId || null : null))
    : null;
  const key = cacheKey(path, token, companyId);

  const cached = getCache.get(key);
  if (cached && cached.expires > Date.now()) return cloneData(cached.data) as T;

  const inflight = getInflight.get(key);
  if (inflight) return cloneData(await inflight) as T;

  const promise = apiCore<T>(path, options);
  getInflight.set(key, promise as Promise<unknown>);
  try {
    const result = await promise;
    getCache.set(key, { data: result, expires: Date.now() + GET_CACHE_TTL_MS });
    return cloneData(result) as T;
  } finally {
    getInflight.delete(key);
  }
}

async function apiCore<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const storedUser = typeof window !== 'undefined' ? localStorage.getItem('user') : null;
  let parsedUser: { role?: string; party_id?: string | null } | null = null;
  if (storedUser) {
    try {
      parsedUser = JSON.parse(storedUser);
    } catch {
      parsedUser = null;
    }
  }
  const isCompanySwitchRole = parsedUser?.role === 'SUPER_ADMIN' || parsedUser?.role === 'ADMIN';
  const fallbackCompanyId = parsedUser?.role === 'ADMIN' ? (parsedUser.party_id || null) : null;
  const companyId = typeof window !== 'undefined'
    ? (isCompanySwitchRole ? (localStorage.getItem('activeCompanyId') || fallbackCompanyId) : null)
    : null;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: options.method || 'GET',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(companyId ? { 'x-company-id': companyId } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    console.error('Network error:', err);
    const isNetworkError = err instanceof TypeError && (
      err.message.toLowerCase().includes('fetch') ||
      err.message.toLowerCase().includes('network') ||
      err.message.toLowerCase().includes('failed to')
    );
    const method = (options.method || 'GET').toUpperCase();
    const shouldRetryNetwork = !options._retried && path.startsWith('/api/v1/') && (method === 'GET' || path === '/api/v1/delivery-lots');
    if (isNetworkError && shouldRetryNetwork) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      return apiCore<T>(path, { ...options, _retried: true });
    }
    if (isNetworkError) {
      throw new Error('Unable to connect to server. Please check your internet connection and try again.');
    }
    throw new Error('Network error. Please check your connection and try again.');
  }

  const data = await parseResponseBody(res) as T & { message?: string };

  const isAuthLoginRequest = path === '/api/v1/auth/login';

  if (res.status === 401) {
    if (isAuthLoginRequest) {
      throw new Error(data?.message || 'Invalid credentials');
    }

    if (!options._retried) {
      // The closed-app foreground service may have rotated the Supabase session.
      // Recover those credentials before attempting the WebView's older refresh token.
      if (syncAuthFromNativeTracking()) {
        return apiCore<T>(path, { ...options, _retried: true });
      }
      const refreshed = await tryRefresh();
      if (refreshed) {
        return apiCore<T>(path, { ...options, _retried: true });
      }
    }

    if (!token) {
      throw new Error(data?.message || 'Unauthorized');
    }

    if (typeof window !== 'undefined') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem('user');
      clearNativeAuthSession();
      window.location.href = '/login';
    }
    throw new Error(data?.message || 'Unauthorized');
  }

  if (res.status === 300) {
    return data;
  }

  if (res.status === 403) {
    throw new Error(data?.message || 'Forbidden');
  }

  if (!res.ok) {
    const normalizedMessage = extractErrorMessage(data, res.status);
    const message = normalizedMessage.toLowerCase();
    const isKnownDeliveryLotsSchemaGap =
      path === '/api/v1/delivery-lots' &&
      (message.includes("public.delivery_lots") || message.includes("delivery_lots table is missing"));
    const isInvoiceRequestsEndpoint = path.startsWith('/api/v1/invoice-requests');
    const isWalletTransactionsEndpoint = path.startsWith('/api/v1/wallet-transactions');
    const isVisitLogsEndpoint = path.includes('/visit-logs');
    const isSchemeProgressEndpoint = path.includes('/schemes/') && (path.includes('/progress') || path.includes('/enroll'));
    const isDutyLocationPing = path === '/api/v1/duty/location';
    const isSupportSchemaGap =
      path.startsWith('/api/v1/support/') &&
      res.status === 503 &&
      (message.includes('migration has not been applied') || message.includes('schema cache'));
    const isBomInventorySchemaGap =
      (path === '/api/v1/raw-materials' || path === '/api/v1/bom-items' || path === '/api/v1/stock-movements') &&
      res.status === 503 &&
      message.includes('migration has not been applied');

    if (!options.suppressErrorLog && !isSupportSchemaGap && !isBomInventorySchemaGap) {
      if (res.status >= 500 && !isKnownDeliveryLotsSchemaGap && !isInvoiceRequestsEndpoint && !isWalletTransactionsEndpoint && !isVisitLogsEndpoint && !isSchemeProgressEndpoint && !isDutyLocationPing) {
        console.error('API Error:', res.status, path, data);
      } else {
        console.warn('API Request Failed:', res.status, path, normalizedMessage);
      }
    }
    throw new Error(normalizedMessage);
  }

  return data;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
  if (!refreshToken) return false;

  try {
    const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await response.json();
    if (!response.ok || !data?.data?.accessToken) return false;

    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', data.data.accessToken);
      localStorage.setItem('refreshToken', data.data.refreshToken);
      persistAuthSessionToNative();
      window.dispatchEvent(new Event('hometech:auth-refreshed'));
    }
    return true;
  } catch {
    return false;
  }
}

export function getUser() {
  if (typeof window === 'undefined') return null;
  const user = localStorage.getItem('user');
  if (!user) return null;
  try { return JSON.parse(user); } catch { return null; }
}

export interface ModulePermission {
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

const FULL_MODULE_PERMISSION: ModulePermission = { can_view: true, can_create: true, can_edit: true, can_delete: true };
const VIEW_ONLY_MODULE_PERMISSION: ModulePermission = { can_view: true, can_create: false, can_edit: false, can_delete: false };

/**
 * Resolve the current user's CRUD permissions for a given module.
 * Admins get full access; other roles are looked up via /permissions/me.
 * Falls back to view-only (never throws) so pages stay usable on failure.
 */
export async function getModulePermission(module: string): Promise<ModulePermission> {
  const user = getUser() as { role?: string; role_id?: string } | null;

  // SUPER_ADMIN and ADMIN have full access to every module.
  if (user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN') {
    return { ...FULL_MODULE_PERMISSION };
  }

  // Resolve permissions by role_id, falling back to role name (mirrors dashboard layout).
  const params = new URLSearchParams();
  if (user?.role_id) params.set('role_id', user.role_id);
  else if (user?.role) params.set('role_name', user.role);
  else return { ...VIEW_ONLY_MODULE_PERMISSION };

  const { id: companyId } = getActiveCompany();
  if (companyId) params.set('company_id', companyId);

  try {
    const res = await api<{ success: boolean; data: Array<{ module: string } & Partial<ModulePermission>> }>(
      `/api/v1/permissions/me?${params.toString()}`
    );
    const match = res?.success ? res.data?.find((p) => p.module === module) : undefined;
    if (!match) return { ...VIEW_ONLY_MODULE_PERMISSION };
    return {
      can_view: !!match.can_view,
      can_create: !!match.can_create,
      can_edit: !!match.can_edit,
      can_delete: !!match.can_delete,
    };
  } catch {
    return { ...VIEW_ONLY_MODULE_PERMISSION };
  }
}

export function isAuthenticated() {
  if (typeof window === 'undefined') return false;
  return !!localStorage.getItem('accessToken');
}

export function setActiveCompany(id: string, name: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('activeCompanyId', id);
  localStorage.setItem('activeCompanyName', name);
  clearApiCache();
}

export function clearActiveCompany() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('activeCompanyId');
  localStorage.removeItem('activeCompanyName');
  clearApiCache();
}

export function getActiveCompany() {
  if (typeof window === 'undefined') return { id: null, name: null };
  const id = localStorage.getItem('activeCompanyId');
  const name = localStorage.getItem('activeCompanyName');
  return { id, name };
}

export function logout() {
  if (typeof window === 'undefined') return;
  clearNativeAuthSession();
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  localStorage.removeItem('activeCompanyId');
  localStorage.removeItem('activeCompanyName');
  clearApiCache();
  window.location.href = '/login';
}

export function isLoggedIn() {
  return isAuthenticated();
}
