import { describe, expect, it } from 'vitest';
import { ago, compact, storage, toDate } from '../src/format.js';
import { mapLimit } from '../src/pool.js';
import { RateLimiter } from '../src/rate-limit.js';
import { assetSummary, backupScreenshotFailed } from '../src/views.js';

const NOW = new Date('2026-10-06T12:00:00Z');

describe('format', () => {
  it('parses unix seconds, milliseconds and ISO strings; 0 means never', () => {
    const iso = '2026-10-06T10:00:00.000Z';
    expect(toDate(1791280800)?.toISOString()).toBe(iso);
    expect(toDate(1791280800000)?.toISOString()).toBe(iso);
    expect(toDate('1791280800')?.toISOString()).toBe(iso);
    expect(toDate(iso)?.toISOString()).toBe(iso);
    expect(toDate(0)).toBeNull();
    expect(toDate('garbage')).toBeNull();
  });

  it('renders relative time', () => {
    expect(ago('2026-10-06T11:30:00Z', NOW)).toBe('vor 30 min');
    expect(ago('2026-10-06T09:00:00Z', NOW)).toBe('vor 3 h');
    expect(ago('2026-10-01T12:00:00Z', NOW)).toBe('vor 5 d');
    expect(ago(null, NOW)).toBeNull();
  });

  it('normalises storage values', () => {
    expect(storage({ size: 512, units: 'GB' })).toBe('512 GB');
    expect(storage({ size: 2048, units: 'GB' })).toBe('2 TB');
    expect(storage(1.25)).toBe('1.3 GB');
    expect(storage({ size: 1720837613, units: 'KB' })).toBe('1.6 TB');
    expect(storage(null)).toBeNull();
  });

  it('compact drops empty values recursively', () => {
    expect(
      compact({ a: 1, b: null, c: '', d: { e: undefined }, f: [], g: [{ h: null, i: 0 }] }),
    ).toEqual({ a: 1, g: [{ i: 0 }] });
  });
});

describe('backupScreenshotFailed', () => {
  it('maps Datto status codes: "1" ok, "" failed, null not run', () => {
    const b = (status: string | null) => ({
      advancedVerification: { screenshotVerification: { status } },
    });
    expect(backupScreenshotFailed(b('1'))).toBe(false);
    expect(backupScreenshotFailed(b(''))).toBe(true);
    expect(backupScreenshotFailed(b(null))).toBe(false);
    expect(backupScreenshotFailed({})).toBe(false);
  });
});

describe('assetSummary volumes', () => {
  it('lists protected and excluded volumes for agents, none for shares', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const agent = {
      name: 'SRV1',
      type: 'agent',
      protectedVolumeNames: ['C:\\'],
      unprotectedVolumeNames: ['D:\\'],
    };
    expect(assetSummary(agent, now).volumes).toEqual({ protected: 'C:\\', excluded: 'D:\\' });
    expect(assetSummary({ ...agent, unprotectedVolumeNames: [] }, now).volumes).toEqual({
      protected: 'C:\\',
    });
    expect(assetSummary({ name: 'Daten', type: 'share' }, now).volumes).toBeUndefined();
  });
});

describe('mapLimit', () => {
  it('keeps order, bounds concurrency and captures failures', async () => {
    let active = 0;
    let peak = 0;
    const res = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (n === 3) throw new Error('boom');
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(res.map((r) => (r.status === 'fulfilled' ? r.value : 'err'))).toEqual([
      10,
      20,
      'err',
      40,
      50,
    ]);
  });
});

describe('RateLimiter', () => {
  it('waits once the window is full', async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(
      2,
      1000,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([]);
    await limiter.acquire();
    expect(waits).toEqual([1000]);
  });
});
