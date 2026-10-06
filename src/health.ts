import type { DattoBcdrClient, RawAsset, RawDevice } from './datto-client.js';
import { ago, ageHours, toDate } from './format.js';
import { mapLimit } from './pool.js';
import {
  assetName,
  backupFailed,
  backupTime,
  clientName,
  deviceName,
  isCloudSiris,
  isShare,
  latestBackup,
  localStoragePercent,
  screenshotAt,
} from './views.js';

export interface Thresholds {
  snapshotMaxAgeHours: number;
  offsiteMaxAgeHours: number;
  screenshotMaxAgeDays: number;
  deviceOfflineHours: number;
  /** Local storage usage that triggers a warning; >= 95 % is always critical. */
  localStorageMaxPercent: number;
  /** Warn this many days before the Datto service period ends. */
  serviceExpiryWarnDays: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  snapshotMaxAgeHours: 24,
  offsiteMaxAgeHours: 48,
  screenshotMaxAgeDays: 7,
  deviceOfflineHours: 1,
  localStorageMaxPercent: 85,
  serviceExpiryWarnDays: 30,
};

const STORAGE_CRITICAL_PERCENT = 95;

export const ISSUE_CODES = [
  'DEVICE_OFFLINE',
  'DEVICE_API_ERROR',
  'LOCAL_STORAGE_HIGH',
  'SERVICE_EXPIRING',
  'AGENT_PAUSED',
  'UNPROTECTED_VOLUMES',
  'SNAPSHOT_STALE',
  'SNAPSHOT_MISSING',
  'BACKUP_FAILED',
  'LOCAL_VERIFICATION_FAILED',
  'OFFSITE_STALE',
  'OFFSITE_MISSING',
  'SCREENSHOT_FAILED',
  'SCREENSHOT_STALE',
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/** Splits a comma-separated list; tool schemas stay flat (string only) for MCP hubs and Copilot Studio. */
export function splitList(value: string | undefined): string[] | undefined {
  const list = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list?.length ? list : undefined;
}

export function parseIssueCodes(value: string | undefined): IssueCode[] | undefined {
  const list = splitList(value)?.map((c) => c.toUpperCase());
  const unknown = list?.filter((c) => !(ISSUE_CODES as readonly string[]).includes(c));
  if (unknown?.length)
    throw new Error(
      `Unbekannte Befund-Codes: ${unknown.join(', ')}. Gültig: ${ISSUE_CODES.join(', ')}`,
    );
  return list as IssueCode[] | undefined;
}

export type Severity = 'critical' | 'warning';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  detail: string;
}

export interface Finding {
  /** Stable key for ticket dedup in n8n: serial + asset name (or "_device"). */
  dedupKey: string;
  severity: Severity;
  serial: string;
  device: string | null;
  client: string | null;
  model: string | null;
  asset: string | null;
  issues: Issue[];
}

export interface HealthReport {
  checkedAt: string;
  thresholds: Thresholds;
  totals: {
    devices: number;
    assets: number;
    skippedAssets: number;
    healthyAssets: number;
    findings: number;
    critical: number;
    warning: number;
  };
  findings: Finding[];
}

export interface FleetFilter {
  /** Case-insensitive substring match on client name. */
  client?: string;
  serials?: string[];
  includeHidden?: boolean;
}

export function filterDevices(devices: RawDevice[], f: FleetFilter): RawDevice[] {
  const client = f.client?.toLowerCase();
  const serials = f.serials?.length ? new Set(f.serials.map((s) => s.toUpperCase())) : null;
  return devices.filter(
    (d) =>
      (f.includeHidden || !d.hidden) &&
      (!client ||
        (clientName(d) ?? '').toLowerCase().includes(client) ||
        (deviceName(d) ?? '').toLowerCase().includes(client)) &&
      (!serials || serials.has(d.serialNumber.toUpperCase())),
  );
}

export function evaluateDevice(d: RawDevice, now: Date, t: Thresholds): Issue[] {
  const issues: Issue[] = [];
  const h = ageHours(d.lastSeenDate, now);
  if (h !== null && h > t.deviceOfflineHours) {
    issues.push({
      code: 'DEVICE_OFFLINE',
      severity: 'critical',
      detail: `Zuletzt online ${ago(d.lastSeenDate, now)}`,
    });
  }
  // A full local pool is the most common root cause of failing backups and pruned recovery points.
  const pct = localStoragePercent(d);
  if (pct !== null && pct >= t.localStorageMaxPercent) {
    issues.push({
      code: 'LOCAL_STORAGE_HIGH',
      severity: pct >= STORAGE_CRITICAL_PERCENT ? 'critical' : 'warning',
      detail: `Lokaler Speicher zu ${pct} % belegt`,
    });
  }
  // Datto service period: once it ends, offsite sync and support stop.
  const service = toDate(d.servicePeriod);
  if (service) {
    const days = Math.floor((service.getTime() - now.getTime()) / 86_400_000);
    const date = service.toISOString().slice(0, 10);
    if (days < 0) {
      issues.push({
        code: 'SERVICE_EXPIRING',
        severity: 'critical',
        detail: `Datto-Servicevertrag abgelaufen am ${date}`,
      });
    } else if (days <= t.serviceExpiryWarnDays) {
      issues.push({
        code: 'SERVICE_EXPIRING',
        severity: 'warning',
        detail: `Datto-Servicevertrag endet am ${date} (in ${days} d)`,
      });
    }
  }
  return issues;
}

/** Archived assets are history only and are skipped entirely. */
export function shouldEvaluate(a: RawAsset): boolean {
  return !a.isArchived;
}

export function evaluateAsset(d: RawDevice, a: RawAsset, now: Date, t: Thresholds): Issue[] {
  // A paused agent produces no backups by design; report the pause itself, not its symptoms.
  // Forgotten pauses after maintenance are a classic silent failure.
  if (a.isPaused) {
    return [
      {
        code: 'AGENT_PAUSED',
        severity: 'warning',
        detail: `Agent pausiert, letzter Snapshot ${ago(a.lastSnapshot, now) ?? 'nie'}`,
      },
    ];
  }

  const issues: Issue[] = [];

  const snapH = ageHours(a.lastSnapshot, now);
  if (snapH === null) {
    issues.push({
      code: 'SNAPSHOT_MISSING',
      severity: 'critical',
      detail: 'Noch kein Snapshot vorhanden',
    });
  } else if (snapH > t.snapshotMaxAgeHours) {
    issues.push({
      code: 'SNAPSHOT_STALE',
      severity: 'critical',
      detail: `Letzter Snapshot ${ago(a.lastSnapshot, now)}`,
    });
  }

  const last = latestBackup(a);
  if (backupFailed(last)) {
    const err = last?.backup?.errorMessage ? `: ${last.backup.errorMessage}` : '';
    issues.push({
      code: 'BACKUP_FAILED',
      severity: 'critical',
      detail: `Letzter Backup-Lauf${suffix(ago(last ? backupTime(last) : null, now))} fehlgeschlagen${err}`,
    });
  } else if (last?.localVerification?.status === 'failure') {
    // Only when the backup itself succeeded; a failed backup always fails verification too.
    issues.push({
      code: 'LOCAL_VERIFICATION_FAILED',
      severity: 'warning',
      detail: `Lokale Verifikation des letzten Backups${suffix(ago(backupTime(last), now))} fehlgeschlagen`,
    });
  }

  const offH = ageHours(a.latestOffsite, now);
  if (offH === null) {
    // Cloud SIRIS lives in the Datto cloud already; a fresh agent without any snapshot has nothing to sync yet.
    if (!isCloudSiris(d) && snapH !== null) {
      issues.push({
        code: 'OFFSITE_MISSING',
        severity: 'warning',
        detail: 'Noch nie offsite synchronisiert',
      });
    }
  } else if (offH > t.offsiteMaxAgeHours) {
    issues.push({
      code: 'OFFSITE_STALE',
      severity: 'warning',
      detail: `Letzter Offsite-Sync ${ago(a.latestOffsite, now)}`,
    });
  }

  if (a.unprotectedVolumesCount && a.unprotectedVolumesCount > 0) {
    issues.push({
      code: 'UNPROTECTED_VOLUMES',
      severity: 'warning',
      detail: a.unprotectedVolumeNames?.length
        ? `Nicht im Backup: ${a.unprotectedVolumeNames.join(', ')}`
        : `${a.unprotectedVolumesCount} Volume(s) nicht im Backup`,
    });
  }

  if (!isShare(a)) {
    const shotAt = screenshotAt(a);
    const shotH = ageHours(shotAt, now);
    if (a.lastScreenshotAttemptStatus === false) {
      issues.push({
        code: 'SCREENSHOT_FAILED',
        severity: 'warning',
        detail: `Screenshot-Verification${suffix(ago(shotAt, now))} fehlgeschlagen`,
      });
    } else if (shotH === null || shotH > t.screenshotMaxAgeDays * 24) {
      issues.push({
        code: 'SCREENSHOT_STALE',
        severity: 'warning',
        detail:
          shotH === null
            ? 'Keine Screenshot-Verification vorhanden'
            : `Letzter Screenshot ${ago(shotAt, now)}`,
      });
    }
  }

  return issues;
}

const suffix = (s: string | null) => (s ? ` ${s}` : '');

function finding(d: RawDevice, asset: string | null, issues: Issue[]): Finding {
  return {
    dedupKey: `${d.serialNumber}:${asset ?? '_device'}`,
    severity: issues.some((i) => i.severity === 'critical') ? 'critical' : 'warning',
    serial: d.serialNumber,
    device: deviceName(d),
    client: clientName(d),
    model: d.model ?? null,
    asset,
    issues,
  };
}

export interface DeviceScan {
  device: RawDevice;
  assets: RawAsset[] | null;
  error: string | null;
}

/** Loads devices (filtered) and their assets with bounded concurrency. Per-device failures are kept, not thrown. */
export async function scanFleet(
  client: DattoBcdrClient,
  filter: FleetFilter,
  concurrency: number,
): Promise<DeviceScan[]> {
  const devices = filterDevices(await client.listDevices(), filter);
  const results = await mapLimit(devices, concurrency, (d) => client.listAssets(d.serialNumber));
  return devices.map((device, i) => {
    const r = results[i];
    return r.status === 'fulfilled'
      ? { device, assets: r.value, error: null }
      : {
          device,
          assets: null,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
  });
}

export interface HealthOptions extends FleetFilter {
  thresholds?: Partial<Thresholds>;
  /** Drop warnings and return only critical findings. */
  criticalOnly?: boolean;
  /** Ignore these issue codes (e.g. SCREENSHOT_STALE for Linux agents). */
  ignore?: IssueCode[];
}

/** Pure evaluation of an already-loaded fleet. Exported for tests and for reuse with cached scans. */
export function buildHealthReport(
  scans: DeviceScan[],
  opts: HealthOptions,
  now: Date,
): HealthReport {
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...stripUndefined(opts.thresholds ?? {}) };
  const ignore = new Set(opts.ignore ?? []);
  const keep = (issues: Issue[]) =>
    issues.filter((i) => !ignore.has(i.code) && (!opts.criticalOnly || i.severity === 'critical'));

  const findings: Finding[] = [];
  let assets = 0;
  let skipped = 0;
  let healthy = 0;

  for (const { device, assets: list, error } of scans) {
    const deviceIssues = keep(evaluateDevice(device, now, t));
    if (error) {
      deviceIssues.push(
        ...keep([
          {
            code: 'DEVICE_API_ERROR',
            severity: 'warning',
            detail: `Assets nicht abrufbar: ${error.slice(0, 200)}`,
          },
        ]),
      );
    }
    if (deviceIssues.length) findings.push(finding(device, null, deviceIssues));

    for (const a of list ?? []) {
      assets++;
      if (!shouldEvaluate(a)) {
        skipped++;
        continue;
      }
      // "healthy" means no issue at all, independent of what criticalOnly/ignore hide from the output.
      const all = evaluateAsset(device, a, now, t);
      if (all.length === 0) healthy++;
      const issues = keep(all);
      if (issues.length) findings.push(finding(device, assetName(a) ?? '?', issues));
    }
  }

  findings.sort(
    (x, y) =>
      (x.severity === y.severity ? 0 : x.severity === 'critical' ? -1 : 1) ||
      (x.client ?? '').localeCompare(y.client ?? '') ||
      x.dedupKey.localeCompare(y.dedupKey),
  );

  const critical = findings.filter((f) => f.severity === 'critical').length;
  return {
    checkedAt: now.toISOString(),
    thresholds: t,
    totals: {
      devices: scans.length,
      assets,
      skippedAssets: skipped,
      healthyAssets: healthy,
      findings: findings.length,
      critical,
      warning: findings.length - critical,
    },
    findings,
  };
}

export async function runHealthCheck(
  client: DattoBcdrClient,
  opts: HealthOptions,
  concurrency: number,
): Promise<HealthReport> {
  const scans = await scanFleet(client, opts, concurrency);
  return buildHealthReport(scans, opts, new Date());
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
