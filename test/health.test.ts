import { describe, expect, it } from 'vitest';
import type { RawAsset, RawDevice } from '../src/datto-client.js';
import {
  buildHealthReport,
  DEFAULT_THRESHOLDS,
  evaluateAsset,
  evaluateDevice,
  filterDevices,
  type DeviceScan,
} from '../src/health.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const secAgo = (h: number) => Math.floor(NOW.getTime() / 1000 - h * 3600);
const isoAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const siris: RawDevice = {
  serialNumber: 'SIRIS1',
  name: 'siris-kunde-a',
  model: 'S5-2',
  clientCompanyName: 'Kunde A',
  lastSeenDate: isoAgo(0.1),
};
const cloud: RawDevice = {
  serialNumber: 'CLD1',
  name: 'cloud-b',
  model: 'CLDSIRIS',
  clientCompanyName: 'Kunde B',
  lastSeenDate: isoAgo(0.1),
};

const healthyAgent: RawAsset = {
  name: 'DC01',
  type: 'agent',
  lastSnapshot: secAgo(2),
  latestOffsite: secAgo(10),
  lastScreenshotAttempt: secAgo(20),
  lastScreenshotAttemptStatus: true,
  backups: [{ timestamp: secAgo(2), backup: { status: 'success' } }],
};

const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

describe('evaluateDevice', () => {
  it('flags devices not seen longer than the threshold', () => {
    expect(
      codes(evaluateDevice({ ...siris, lastSeenDate: isoAgo(3) }, NOW, DEFAULT_THRESHOLDS)),
    ).toEqual(['DEVICE_OFFLINE']);
    expect(evaluateDevice(siris, NOW, DEFAULT_THRESHOLDS)).toEqual([]);
  });
});

describe('evaluateAsset', () => {
  it('returns nothing for a healthy agent', () => {
    expect(evaluateAsset(siris, healthyAgent, NOW, DEFAULT_THRESHOLDS)).toEqual([]);
  });

  it('detects stale snapshot, stale offsite and failed screenshot', () => {
    const a: RawAsset = {
      ...healthyAgent,
      lastSnapshot: secAgo(30),
      latestOffsite: secAgo(72),
      lastScreenshotAttemptStatus: false,
    };
    expect(codes(evaluateAsset(siris, a, NOW, DEFAULT_THRESHOLDS))).toEqual([
      'OFFSITE_STALE',
      'SCREENSHOT_FAILED',
      'SNAPSHOT_STALE',
    ]);
  });

  it('uses the newest backup regardless of array order', () => {
    const a: RawAsset = {
      ...healthyAgent,
      backups: [
        { timestamp: secAgo(30), backup: { status: 'success' } },
        { timestamp: secAgo(1), backup: { status: 'failure', errorMessage: 'VSS error' } },
      ],
    };
    const issues = evaluateAsset(siris, a, NOW, DEFAULT_THRESHOLDS);
    expect(codes(issues)).toEqual(['BACKUP_FAILED']);
    expect(issues[0].detail).toContain('VSS error');
  });

  it('does not require offsite or screenshots where they do not apply', () => {
    const share: RawAsset = {
      name: 'Daten',
      type: 'share',
      lastSnapshot: secAgo(1),
      latestOffsite: secAgo(5),
    };
    expect(evaluateAsset(siris, share, NOW, DEFAULT_THRESHOLDS)).toEqual([]);

    const cloudAgent: RawAsset = { ...healthyAgent, latestOffsite: null };
    expect(evaluateAsset(cloud, cloudAgent, NOW, DEFAULT_THRESHOLDS)).toEqual([]);
    expect(codes(evaluateAsset(siris, cloudAgent, NOW, DEFAULT_THRESHOLDS))).toEqual([
      'OFFSITE_MISSING',
    ]);
  });

  it('accepts the alternative field name latestScreenshot', () => {
    const a: RawAsset = {
      ...healthyAgent,
      lastScreenshotAttempt: undefined,
      latestScreenshot: secAgo(24 * 10),
    };
    expect(codes(evaluateAsset(siris, a, NOW, DEFAULT_THRESHOLDS))).toEqual(['SCREENSHOT_STALE']);
  });
});

describe('root-cause checks', () => {
  it('flags local storage by percentage, critical from 95 %', () => {
    const at = (used: number) => ({
      ...siris,
      localStorageUsed: { size: used, units: 'GB' },
      localStorageAvailable: { size: 100 - used, units: 'GB' },
    });
    expect(evaluateDevice(at(50), NOW, DEFAULT_THRESHOLDS)).toEqual([]);
    expect(evaluateDevice(at(90), NOW, DEFAULT_THRESHOLDS)).toEqual([
      {
        code: 'LOCAL_STORAGE_HIGH',
        severity: 'warning',
        detail: 'Lokaler Speicher zu 90 % belegt',
      },
    ]);
    expect(evaluateDevice(at(97), NOW, DEFAULT_THRESHOLDS)[0].severity).toBe('critical');
    // CLDSIRIS reports null storage: no false positive
    expect(
      evaluateDevice(
        { ...cloud, localStorageUsed: null, localStorageAvailable: null },
        NOW,
        DEFAULT_THRESHOLDS,
      ),
    ).toEqual([]);
  });

  it('reports a paused agent once instead of its stale-snapshot symptoms', () => {
    const paused: RawAsset = {
      ...healthyAgent,
      isPaused: true,
      lastSnapshot: secAgo(24 * 20),
      lastScreenshotAttemptStatus: false,
    };
    expect(codes(evaluateAsset(siris, paused, NOW, DEFAULT_THRESHOLDS))).toEqual(['AGENT_PAUSED']);
  });

  it('warns about volumes excluded from the backup', () => {
    expect(
      codes(
        evaluateAsset(
          siris,
          { ...healthyAgent, unprotectedVolumesCount: 2 },
          NOW,
          DEFAULT_THRESHOLDS,
        ),
      ),
    ).toEqual(['UNPROTECTED_VOLUMES']);
  });
});

describe('checks derived from the real API', () => {
  it('warns before the Datto service period ends and is critical once expired', () => {
    const at = (days: number) => ({
      ...siris,
      servicePeriod: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
    });
    expect(evaluateDevice(at(90), NOW, DEFAULT_THRESHOLDS)).toEqual([]);
    expect(evaluateDevice(at(26), NOW, DEFAULT_THRESHOLDS)[0]).toMatchObject({
      code: 'SERVICE_EXPIRING',
      severity: 'warning',
    });
    expect(evaluateDevice(at(-2), NOW, DEFAULT_THRESHOLDS)[0]).toMatchObject({
      code: 'SERVICE_EXPIRING',
      severity: 'critical',
    });
  });

  it('reports failed local verification only when the backup itself succeeded', () => {
    const verify = (status: string) => ({
      ...healthyAgent,
      backups: [
        { timestamp: isoAgo(1), backup: { status }, localVerification: { status: 'failure' } },
      ],
    });
    expect(codes(evaluateAsset(siris, verify('success'), NOW, DEFAULT_THRESHOLDS))).toEqual([
      'LOCAL_VERIFICATION_FAILED',
    ]);
    expect(codes(evaluateAsset(siris, verify('failure'), NOW, DEFAULT_THRESHOLDS))).toEqual([
      'BACKUP_FAILED',
    ]);
  });

  it('names the unprotected volumes', () => {
    const a: RawAsset = {
      ...healthyAgent,
      unprotectedVolumesCount: 2,
      unprotectedVolumeNames: ['D:\\', 'E:\\'],
    };
    expect(evaluateAsset(siris, a, NOW, DEFAULT_THRESHOLDS)[0].detail).toBe(
      'Nicht im Backup: D:\\, E:\\',
    );
  });
});

describe('buildHealthReport', () => {
  const scans: DeviceScan[] = [
    {
      device: siris,
      assets: [
        healthyAgent,
        { ...healthyAgent, name: 'FS01', lastSnapshot: secAgo(48) },
        { ...healthyAgent, name: 'OLD', isArchived: true, lastSnapshot: secAgo(1000) },
        { ...healthyAgent, name: 'PAUSED', isPaused: true },
        { ...healthyAgent, name: 'APP01', lastScreenshotAttemptStatus: false },
      ],
      error: null,
    },
    { device: { ...cloud, lastSeenDate: isoAgo(5) }, assets: null, error: 'Datto API 500' },
  ];

  it('returns only problems, sorted critical first, with dedup keys', () => {
    const r = buildHealthReport(scans, {}, NOW);
    expect(r.totals).toMatchObject({
      devices: 2,
      assets: 5,
      skippedAssets: 1,
      healthyAssets: 1,
      findings: 4,
      critical: 2,
      warning: 2,
    });
    expect(r.findings.map((f) => f.dedupKey)).toEqual([
      'SIRIS1:FS01',
      'CLD1:_device',
      'SIRIS1:APP01',
      'SIRIS1:PAUSED',
    ]);
    expect(codes(r.findings[1].issues)).toEqual(['DEVICE_API_ERROR', 'DEVICE_OFFLINE']);
  });

  it('honours threshold overrides, criticalOnly and ignore', () => {
    const r = buildHealthReport(
      scans,
      {
        thresholds: { snapshotMaxAgeHours: 72, deviceOfflineHours: undefined },
        criticalOnly: true,
      },
      NOW,
    );
    expect(r.thresholds.snapshotMaxAgeHours).toBe(72);
    expect(r.thresholds.deviceOfflineHours).toBe(1);
    expect(r.findings.map((f) => f.dedupKey)).toEqual(['CLD1:_device']);
    expect(r.totals.healthyAssets).toBe(2);

    const r2 = buildHealthReport(
      scans,
      { ignore: ['SCREENSHOT_FAILED', 'DEVICE_API_ERROR', 'DEVICE_OFFLINE', 'AGENT_PAUSED'] },
      NOW,
    );
    expect(r2.findings.map((f) => f.dedupKey)).toEqual(['SIRIS1:FS01']);
  });
});

describe('filterDevices', () => {
  it('filters by client substring and hides hidden devices by default', () => {
    const list = [siris, cloud, { ...siris, serialNumber: 'H1', hidden: true }];
    expect(filterDevices(list, { client: 'kunde a' }).map((d) => d.serialNumber)).toEqual([
      'SIRIS1',
    ]);
    expect(filterDevices(list, { client: 'kunde a', includeHidden: true })).toHaveLength(2);
    expect(filterDevices(list, { serials: ['cld1'] }).map((d) => d.serialNumber)).toEqual(['CLD1']);
  });
});
