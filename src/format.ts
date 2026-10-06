import type { StorageValue } from './datto-client.js';

const HOUR = 3_600_000;

/**
 * Datto returns timestamps either as unix seconds (asset endpoints) or ISO strings (device endpoints).
 * 0 / negative values mean "never" and map to null.
 */
export function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ageHours(value: string | number | null | undefined, now: Date): number | null {
  const d = toDate(value);
  if (!d) return null;
  return Math.max(0, (now.getTime() - d.getTime()) / HOUR);
}

/** Compact relative time for LLM output, e.g. "vor 3 h". */
export function ago(value: string | number | null | undefined, now: Date): string | null {
  const h = ageHours(value, now);
  if (h === null) return null;
  const min = h * 60;
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${Math.round(min)} min`;
  if (h < 48) return `vor ${Math.round(h)} h`;
  return `vor ${Math.round(h / 24)} d`;
}

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
};

/** Storage value in bytes, or null if unknown (Cloud SIRIS returns null for local storage). */
export function storageBytes(value: StorageValue | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value * UNIT_BYTES.gb;
  if (value.size === null || value.size === undefined) return null;
  return value.size * (UNIT_BYTES[(value.units ?? 'GB').toLowerCase()] ?? UNIT_BYTES.gb);
}

/** Normalises Datto storage values ({size, units} or plain GB number) to a readable string. */
export function storage(value: StorageValue | null | undefined): string | null {
  const bytes = storageBytes(value);
  if (bytes === null) return null;
  const tb = bytes / UNIT_BYTES.tb;
  return tb >= 1 ? `${round(tb)} TB` : `${round(bytes / UNIT_BYTES.gb)} GB`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Recursively drop null/undefined/empty values so tool output stays small. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact).filter((v) => v !== undefined) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '') continue;
      const c = compact(v);
      if (Array.isArray(c) && c.length === 0) continue;
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out as T;
  }
  return value;
}
