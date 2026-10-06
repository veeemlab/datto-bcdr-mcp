import type { Config } from './config.js';
import { RateLimiter } from './rate-limit.js';

/**
 * Raw API shapes. Field names follow the Datto BCDR REST API as known from experience and
 * MUST be verified against the Swagger UI ("datto | Unified Continuity" in the Partner Portal).
 * Everything is optional on purpose: Cloud SIRIS (model CLDSIRIS) returns null for several
 * fields, and unknown fields are passed through untouched.
 */
export interface RawDevice {
  serialNumber: string;
  name?: string | null;
  hostname?: string | null;
  model?: string | null;
  clientCompanyName?: string | null;
  organizationName?: string | null;
  hidden?: boolean | null;
  lastSeenDate?: string | number | null;
  uptime?: number | null;
  agentCount?: number | null;
  shareCount?: number | null;
  alertCount?: number | null;
  activeTickets?: number | null;
  internalIP?: string | null;
  localStorageUsed?: StorageValue | null;
  localStorageAvailable?: StorageValue | null;
  offsiteStorageUsed?: StorageValue | null;
  totalManagedDisk?: StorageValue | null;
  region?: string | null;
  servicePlan?: string | null;
  /** End of the Datto service contract (ISO). Offsite/support stop afterwards. */
  servicePeriod?: string | null;
  remoteWebUrl?: string | null;
  warrantyExpire?: string | null;
  [key: string]: unknown;
}

export type StorageValue = number | { size?: number | null; units?: string | null };

export interface RawBackup {
  /** ISO timestamp of the backup run (real API). `created` is kept as a fallback for older docs. */
  timestamp?: string | number | null;
  created?: string | number | null;
  backup?: { status?: string | null; errorMessage?: string | null } | null;
  localVerification?: { status?: string | null; errors?: unknown[] | null } | null;
  advancedVerification?: {
    screenshotVerification?: { status?: string | null; image?: string | null } | null;
  } | null;
  [key: string]: unknown;
}

export interface RawAsset {
  name?: string | null;
  hostname?: string | null;
  agentId?: string | null;
  fqdn?: string | null;
  type?: string | null;
  os?: string | null;
  localIp?: string | null;
  agentVersion?: string | null;
  isPaused?: boolean | null;
  isArchived?: boolean | null;
  protectedVolumesCount?: number | null;
  unprotectedVolumesCount?: number | null;
  protectedVolumeNames?: string[] | null;
  unprotectedVolumeNames?: string[] | null;
  assetId?: number | null;
  localSnapshots?: number | null;
  lastSnapshot?: string | number | null;
  latestOffsite?: string | number | null;
  lastScreenshotAttempt?: string | number | null;
  latestScreenshot?: string | number | null;
  lastScreenshotAttemptStatus?: boolean | null;
  lastScreenshotUrl?: string | null;
  backups?: RawBackup[] | null;
  [key: string]: unknown;
}

export interface RawAlert {
  type?: string | null;
  dateTriggered?: string | number | null;
  dateCleared?: string | number | null;
  createdAt?: string | number | null;
  resolvedAt?: string | number | null;
  [key: string]: unknown;
}

interface Paged<T> {
  pagination?: { page?: number; perPage?: number; totalPages?: number; count?: number };
  items?: T[];
}

export class DattoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'DattoApiError';
  }
}

/** API maximum; fewer pages = fewer requests against the rate limit. */
const PER_PAGE = 250;
const MAX_PAGES = 200;
const RETRYABLE = new Set([429, 502, 503, 504]);

export class DattoBcdrClient {
  private readonly authHeader: string;
  /** Short-lived GET cache so consecutive tool calls in one conversation do not rescan the whole fleet. */
  private readonly cache = new Map<string, { expires: number; data: Promise<unknown> }>();

  private readonly limiter: RateLimiter;

  constructor(private readonly config: Config) {
    this.limiter = new RateLimiter(config.rateLimitPerMinute);
    this.authHeader =
      'Basic ' + Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');
  }

  private request<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    if (this.config.cacheTtlMs <= 0) return this.fetchJson<T>(url, path);

    const key = url.toString();
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.data as Promise<T>;

    const data = this.fetchJson<T>(url, path);
    this.cache.set(key, { expires: now + this.config.cacheTtlMs, data });
    data.catch(() => this.cache.delete(key));
    if (this.cache.size > 2000) {
      for (const [k, v] of this.cache) if (v.expires <= now) this.cache.delete(k);
    }
    return data;
  }

  private async fetchJson<T>(url: URL, path: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      const res = await fetch(url, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      if (res.ok) return (await res.json()) as T;

      if (RETRYABLE.has(res.status) && attempt < 3) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30_000)
            : (res.status === 429 ? 5_000 : 500) * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const body = (await res.text().catch(() => '')).slice(0, 300);
      const hint =
        res.status === 401
          ? ' (public/secret key pair invalid or deactivated)'
          : res.status === 403
            ? ' (key is restricted to a client/vendor?)'
            : '';
      throw new DattoApiError(
        `Datto API ${res.status} on ${path}${hint}: ${body}`,
        res.status,
        path,
      );
    }
  }

  /** Fetch every page of a paginated endpoint. Also accepts endpoints that return a bare array. */
  private async requestAll<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.request<Paged<T> | T[]>(path, { _page: page, _perPage: PER_PAGE });
      if (Array.isArray(data)) return data;
      const items = data.items ?? [];
      all.push(...items);
      const totalPages = data.pagination?.totalPages;
      if (totalPages !== undefined ? page >= totalPages : items.length < PER_PAGE) break;
    }
    return all;
  }

  listDevices(): Promise<RawDevice[]> {
    return this.requestAll<RawDevice>('/device');
  }

  getDevice(serial: string): Promise<RawDevice> {
    return this.request<RawDevice>(`/device/${encodeURIComponent(serial)}`);
  }

  listAssets(serial: string): Promise<RawAsset[]> {
    return this.requestAll<RawAsset>(`/device/${encodeURIComponent(serial)}/asset`);
  }

  listAlerts(serial: string): Promise<RawAlert[]> {
    return this.requestAll<RawAlert>(`/device/${encodeURIComponent(serial)}/alert`);
  }

  /**
   * Download a screenshot image. Only https URLs on Datto-owned hosts are fetched (the URL comes from
   * API data, so this keeps the server from being used as an open proxy). Credentials are only sent to
   * the API host itself.
   */
  async getImage(urlOrPath: string): Promise<{ data: string; mimeType: string }> {
    const url = new URL(urlOrPath, this.config.baseUrl + '/');
    const apiHost = new URL(this.config.baseUrl).host;
    if (url.protocol !== 'https:' || !/(^|\.)(datto\.com|dattobackup\.com)$/i.test(url.hostname)) {
      throw new Error(`Refusing to fetch screenshot from non-Datto URL ${url.host}`);
    }
    await this.limiter.acquire();
    const res = await fetch(url, {
      headers: url.host === apiHost ? { Authorization: this.authHeader } : {},
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });
    if (!res.ok)
      throw new DattoApiError(
        `Screenshot download failed: HTTP ${res.status}`,
        res.status,
        url.pathname,
      );
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'image/png';
    if (!mimeType.startsWith('image/'))
      throw new Error(`Screenshot URL returned ${mimeType}, not an image`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('Screenshot larger than 5 MB');
    return { data: buf.toString('base64'), mimeType };
  }

  listVmRestores(serial: string): Promise<Record<string, unknown>[]> {
    return this.requestAll<Record<string, unknown>>(
      `/device/${encodeURIComponent(serial)}/vm-restores`,
    );
  }
}
