function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}

function nonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0, got "${raw}"`);
  return n;
}

export interface Config {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  concurrency: number;
  timeoutMs: number;
  /** Datto allows ~120 req/min per key; keep headroom. */
  rateLimitPerMinute: number;
  /** TTL of the in-memory GET cache. 0 disables caching. */
  cacheTtlMs: number;
  port: number;
  host: string;
  /** Optional bearer token protecting /mcp and /api. Empty = no auth (only for local use). */
  authToken: string;
  allowedHosts: string[];
}

export function loadConfig(): Config {
  return {
    publicKey: required('DATTO_BCDR_PUBLIC_KEY'),
    secretKey: required('DATTO_BCDR_SECRET_KEY'),
    baseUrl: (process.env.DATTO_BCDR_BASE_URL ?? 'https://api.datto.com/v1/bcdr').replace(
      /\/+$/,
      '',
    ),
    concurrency: int('DATTO_BCDR_CONCURRENCY', 5),
    timeoutMs: int('DATTO_BCDR_TIMEOUT_MS', 30_000),
    rateLimitPerMinute: int('DATTO_BCDR_RATE_LIMIT_PER_MINUTE', 100),
    cacheTtlMs: nonNegative('DATTO_BCDR_CACHE_TTL_SECONDS', 60) * 1000,
    port: int('PORT', 3000),
    host: process.env.HOST ?? '127.0.0.1',
    authToken: process.env.MCP_AUTH_TOKEN?.trim() ?? '',
    allowedHosts: (process.env.ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  };
}
