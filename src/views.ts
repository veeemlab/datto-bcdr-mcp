import type { RawAsset, RawBackup, RawDevice } from './datto-client.js';
import { ago, ageHours, compact, storage, storageBytes, toDate } from './format.js';

/** Trimmed shapes handed to the LLM. Field selection is deliberate: keep the context small. */

export function clientName(d: RawDevice): string | null {
  return d.clientCompanyName?.trim() || d.organizationName?.trim() || null;
}

export function backupTime(b: RawBackup): string | number | null {
  return b.timestamp ?? b.created ?? null;
}

/** Datto reports screenshotVerification.status as "1" (ok), "" (failed) or null (not run). */
export function backupScreenshotFailed(b: RawBackup): boolean {
  const s = b.advancedVerification?.screenshotVerification?.status;
  if (s === null || s === undefined) return false;
  return s === '' || s === '0' || /fail|error/i.test(s);
}

/**
 * Field names differ between the Datto docs and third-party clients (name vs hostname,
 * lastScreenshotAttempt vs latestScreenshot). Resolve both until the smoke test confirms the real shape.
 */
export function deviceName(d: RawDevice): string | null {
  return d.name ?? d.hostname ?? null;
}

export function assetName(a: RawAsset): string | null {
  return a.name ?? a.hostname ?? a.fqdn ?? a.agentId ?? null;
}

export function screenshotAt(a: RawAsset): string | number | null {
  return a.lastScreenshotAttempt ?? a.latestScreenshot ?? null;
}

export function isCloudSiris(d: RawDevice): boolean {
  return (d.model ?? '').toUpperCase().includes('CLDSIRIS');
}

export function isShare(a: RawAsset): boolean {
  return (a.type ?? '').toLowerCase().includes('share');
}

export function deviceOnline(d: RawDevice, now: Date, offlineAfterHours: number): boolean | null {
  const h = ageHours(d.lastSeenDate, now);
  return h === null ? null : h <= offlineAfterHours;
}

export function deviceSummary(d: RawDevice, now: Date, offlineAfterHours: number) {
  return compact({
    serial: d.serialNumber,
    name: deviceName(d),
    model: d.model,
    client: clientName(d),
    online: deviceOnline(d, now, offlineAfterHours),
    lastSeen: ago(d.lastSeenDate, now),
    agents: d.agentCount,
    shares: d.shareCount,
    alerts: d.alertCount,
    hidden: d.hidden || undefined,
  });
}

/** Local storage usage in percent, null when the device does not report it (e.g. CLDSIRIS). */
export function localStoragePercent(d: RawDevice): number | null {
  const used = storageBytes(d.localStorageUsed);
  const free = storageBytes(d.localStorageAvailable);
  if (used === null || free === null || used + free <= 0) return null;
  return Math.round((used / (used + free)) * 100);
}

export function deviceDetail(d: RawDevice, now: Date, offlineAfterHours: number) {
  return compact({
    ...deviceSummary(d, now, offlineAfterHours),
    internalIP: d.internalIP,
    region: d.region,
    servicePlan: d.servicePlan,
    serviceUntil: d.servicePeriod?.slice(0, 10),
    portal: d.remoteWebUrl,
    warrantyExpire: d.warrantyExpire?.slice(0, 10),
    uptimeDays: typeof d.uptime === 'number' ? Math.round(d.uptime / 86_400) : undefined,
    activeTickets: d.activeTickets,
    storage: {
      localUsed: storage(d.localStorageUsed),
      localAvailable: storage(d.localStorageAvailable),
      localUsedPercent: localStoragePercent(d),
      offsiteUsed: storage(d.offsiteStorageUsed),
      totalManagedDisk: storage(d.totalManagedDisk),
    },
  });
}

/** Newest backup first; Datto does not guarantee ordering. */
export function latestBackup(a: RawAsset): RawBackup | null {
  const list = a.backups ?? [];
  if (list.length === 0) return null;
  const ts = (b: RawBackup) => toDate(backupTime(b))?.getTime() ?? 0;
  return [...list].sort((x, y) => ts(y) - ts(x))[0];
}

export function backupFailed(b: RawBackup | null): boolean {
  const s = (b?.backup?.status ?? '').toLowerCase();
  return s.includes('fail') || s.includes('error');
}

/** e.g. "C:\, D:\" (as in the API), falls back to the count when the API omits names. */
function volumeList(names: string[] | null | undefined, count: number | null | undefined) {
  if (names?.length) return names.join(', ');
  return count ? `${count} Volume(s)` : undefined;
}

export function assetSummary(a: RawAsset, now: Date) {
  const last = latestBackup(a);
  return compact({
    name: assetName(a),
    fqdn: a.fqdn && a.fqdn !== assetName(a) ? a.fqdn : undefined,
    type: a.type,
    os: a.os,
    paused: a.isPaused || undefined,
    archived: a.isArchived || undefined,
    lastSnapshot: ago(a.lastSnapshot, now) ?? 'nie',
    latestOffsite: ago(a.latestOffsite, now) ?? 'nie',
    screenshot: isShare(a)
      ? undefined
      : {
          lastAttempt: ago(screenshotAt(a), now),
          ok: a.lastScreenshotAttemptStatus,
        },
    lastBackup: last
      ? {
          when: ago(backupTime(last), now),
          status: last.backup?.status,
          error: last.backup?.errorMessage,
          localVerification: last.localVerification?.status === 'failure' ? 'failure' : undefined,
        }
      : undefined,
    localSnapshots: a.localSnapshots,
    // Shares have no volumes; for agents show both lists so "is D: backed up?" is answerable directly.
    volumes: isShare(a)
      ? undefined
      : {
          protected: volumeList(a.protectedVolumeNames, a.protectedVolumesCount),
          excluded: volumeList(a.unprotectedVolumeNames, a.unprotectedVolumesCount),
        },
  });
}
