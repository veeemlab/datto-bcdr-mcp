import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import type { DattoBcdrClient, RawAlert } from './datto-client.js';
import { ago, ageHours, compact, toDate } from './format.js';
import {
  buildHealthReport,
  DEFAULT_THRESHOLDS,
  filterDevices,
  ISSUE_CODES,
  parseIssueCodes,
  runHealthCheck,
  scanFleet,
  splitList,
} from './health.js';
import { mapLimit } from './pool.js';
import {
  assetName,
  assetSummary,
  backupScreenshotFailed,
  backupTime,
  clientName,
  deviceDetail,
  deviceName,
  deviceSummary,
  isShare,
  screenshotAt,
} from './views.js';

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  }
).version;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const serial = z.string().min(1).describe('Seriennummer des Datto-Geräts (z. B. aus list-devices)');
const clientFilter = z
  .string()
  .optional()
  .describe('Filter: Teilstring des Kunden- oder Gerätenamens');
const includeHidden = z
  .boolean()
  .optional()
  .describe('Auch im Portal ausgeblendete Geräte einbeziehen (Standard: false)');

function json(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

async function guarded(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    };
  }
}

export function createServer(client: DattoBcdrClient, config: Config): McpServer {
  const server = new McpServer(
    { name: 'datto-bcdr-mcp', version: VERSION },
    {
      instructions:
        'Read-only Zugriff auf Datto BCDR (SIRIS, ALTO, Cloud SIRIS/DBMA). ' +
        "Für Flottenfragen ('welche Backups sind kaputt?') zuerst get-backup-health-summary nutzen, " +
        'für einzelne Server find-asset, danach Detail-Tools mit der Seriennummer. Zeitangaben sind relativ.',
    },
  );
  const offline = DEFAULT_THRESHOLDS.deviceOfflineHours;

  server.registerTool(
    'list-devices',
    {
      title: 'Datto-Geräte auflisten',
      description:
        'Listet alle BCDR-Geräte (SIRIS, ALTO, CLDSIRIS) mit Kunde, Modell, Online-Status, Agent-/Share-Anzahl und offenen Alerts.',
      inputSchema: {
        client: clientFilter,
        model: z
          .string()
          .optional()
          .describe("Filter: Teilstring des Modells, z. B. 'CLDSIRIS', 'ALTO', 'S5'"),
        onlyOffline: z
          .boolean()
          .optional()
          .describe('Nur Geräte, die seit über 1 h nicht gesehen wurden'),
        includeHidden,
      },
      annotations: READ_ONLY,
    },
    ({ client: c, model, onlyOffline, includeHidden: hidden }) =>
      guarded(async () => {
        const now = new Date();
        const m = model?.toLowerCase();
        const devices = filterDevices(await client.listDevices(), {
          client: c,
          includeHidden: hidden,
        })
          .filter((d) => !m || (d.model ?? '').toLowerCase().includes(m))
          .map((d) => deviceSummary(d, now, offline))
          .filter((d) => !onlyOffline || d.online === false)
          .sort(
            (a, b) =>
              (a.client ?? '').localeCompare(b.client ?? '') ||
              (a.name ?? '').localeCompare(b.name ?? ''),
          );
        return { count: devices.length, devices };
      }),
  );

  server.registerTool(
    'get-device',
    {
      title: 'Datto-Gerät Details',
      description:
        'Details eines Geräts: Modell, Kunde, Online-Status, Speicherbelegung lokal/offsite, Region (CLDSIRIS), Garantie.',
      inputSchema: { serial },
      annotations: READ_ONLY,
    },
    ({ serial: s }) =>
      guarded(async () => deviceDetail(await client.getDevice(s), new Date(), offline)),
  );

  server.registerTool(
    'list-device-assets',
    {
      title: 'Agents/Shares eines Geräts',
      description:
        'Alle geschützten Agents und Shares eines Geräts mit letztem Snapshot, Offsite-Sync, Screenshot-Verification und letztem Backup-Status.',
      inputSchema: {
        serial,
        name: z.string().optional().describe('Filter: Teilstring des Asset-Namens'),
      },
      annotations: READ_ONLY,
    },
    ({ serial: s, name }) =>
      guarded(async () => {
        const now = new Date();
        const n = name?.toLowerCase();
        const assets = (await client.listAssets(s))
          .filter((a) => !n || `${assetName(a) ?? ''} ${a.fqdn ?? ''}`.toLowerCase().includes(n))
          .map((a) => assetSummary(a, now));
        return { serial: s, count: assets.length, assets };
      }),
  );

  server.registerTool(
    'list-alerts',
    {
      title: 'Aktive Alerts',
      description:
        'Aktive (nicht geräumte) Alerts. Mit Seriennummer für ein Gerät, ohne Seriennummer flottenweit (nur Geräte mit Alerts).',
      inputSchema: { serial: serial.optional(), client: clientFilter, includeHidden },
      annotations: READ_ONLY,
    },
    ({ serial: s, client: c, includeHidden: hidden }) =>
      guarded(async () => {
        const now = new Date();
        const active = (list: RawAlert[]) =>
          list
            .filter((a) => !(a.dateCleared ?? a.resolvedAt))
            .map(({ dateTriggered, createdAt, dateCleared: _c, resolvedAt: _r, ...rest }) =>
              compact({ ...rest, triggered: ago(dateTriggered ?? createdAt, now) }),
            );
        if (s) {
          const alerts = active(await client.listAlerts(s));
          return { serial: s, count: alerts.length, alerts };
        }
        // alertCount on the device list lets us skip devices without alerts instead of calling /alert for every one.
        const devices = filterDevices(await client.listDevices(), {
          client: c,
          includeHidden: hidden,
        }).filter((d) => d.alertCount === undefined || d.alertCount === null || d.alertCount > 0);
        const results = await mapLimit(devices, config.concurrency, (d) =>
          client.listAlerts(d.serialNumber),
        );
        const out = devices.flatMap((d, i) => {
          const r = results[i];
          const alerts = r.status === 'fulfilled' ? active(r.value) : [];
          return alerts.length
            ? [
                compact({
                  serial: d.serialNumber,
                  device: deviceName(d),
                  client: clientName(d),
                  alerts,
                }),
              ]
            : [];
        });
        const notChecked = devices
          .filter((_, i) => results[i].status === 'rejected')
          .map((d) => d.serialNumber);
        out.sort((x, y) => (x.client ?? '').localeCompare(y.client ?? ''));
        return compact({
          devicesWithAlerts: out.length,
          alerts: out.reduce((n, d) => n + d.alerts.length, 0),
          results: out,
          devicesNotChecked: notChecked,
        });
      }),
  );

  server.registerTool(
    'list-active-restores',
    {
      title: 'Laufende Virtualisierungen',
      description:
        'Laufende VM-Restores/Virtualisierungen. Ohne Seriennummer wird die ganze Flotte geprüft und nur Geräte mit aktiven Restores zurückgegeben.',
      inputSchema: { serial: serial.optional(), client: clientFilter, includeHidden },
      annotations: READ_ONLY,
    },
    ({ serial: s, client: c, includeHidden: hidden }) =>
      guarded(async () => {
        if (s) {
          const restores = await client.listVmRestores(s);
          return { serial: s, count: restores.length, restores: compact(restores) };
        }
        const devices = filterDevices(await client.listDevices(), {
          client: c,
          includeHidden: hidden,
        });
        const results = await mapLimit(devices, config.concurrency, (d) =>
          client.listVmRestores(d.serialNumber),
        );
        const out = devices.flatMap((d, i) => {
          const r = results[i];
          return r.status === 'fulfilled' && r.value.length
            ? [
                compact({
                  serial: d.serialNumber,
                  device: deviceName(d),
                  client: clientName(d),
                  restores: r.value,
                }),
              ]
            : [];
        });
        const notChecked = devices
          .filter((_, i) => results[i].status === 'rejected')
          .map((d) => d.serialNumber);
        return compact({
          devicesChecked: devices.length,
          devicesWithRestores: out.length,
          results: out,
          devicesNotChecked: notChecked,
        });
      }),
  );

  server.registerTool(
    'get-backup-health-summary',
    {
      title: 'Backup Health Summary (Flotte)',
      description:
        'Prüft alle Geräte und Agents gegen Schwellwerte und gibt NUR Problemfälle zurück. Kritisch: Gerät offline, Snapshot zu alt/fehlend, ' +
        'letzter Backup-Lauf fehlgeschlagen, lokaler Speicher >= 95 %, Datto-Servicevertrag abgelaufen. Warnung: Offsite-Sync zu alt, ' +
        'Screenshot-Verification fehlgeschlagen/zu alt, lokale Verifikation fehlgeschlagen, lokaler Speicher über Schwellwert, ' +
        'Servicevertrag endet bald, Agent pausiert, Volumes nicht im Backup. Archivierte Agents werden übersprungen. ' +
        `Standard: Snapshot ${DEFAULT_THRESHOLDS.snapshotMaxAgeHours} h, Offsite ${DEFAULT_THRESHOLDS.offsiteMaxAgeHours} h, ` +
        `Screenshot ${DEFAULT_THRESHOLDS.screenshotMaxAgeDays} d, Offline ${DEFAULT_THRESHOLDS.deviceOfflineHours} h, Speicher ${DEFAULT_THRESHOLDS.localStorageMaxPercent} %, Servicevertrag ${DEFAULT_THRESHOLDS.serviceExpiryWarnDays} d.`,
      inputSchema: {
        client: clientFilter,
        serials: z
          .string()
          .optional()
          .describe('Nur diese Geräte prüfen, kommagetrennte Seriennummern'),
        snapshotMaxAgeHours: z.number().positive().optional(),
        offsiteMaxAgeHours: z.number().positive().optional(),
        screenshotMaxAgeDays: z.number().positive().optional(),
        deviceOfflineHours: z.number().positive().optional(),
        localStorageMaxPercent: z.number().min(1).max(100).optional(),
        serviceExpiryWarnDays: z.number().min(0).optional(),
        criticalOnly: z.boolean().optional().describe('Nur kritische Befunde (keine Warnungen)'),
        ignore: z
          .string()
          .optional()
          .describe(
            `Kommagetrennte Befund-Codes, die ignoriert werden. Gültig: ${ISSUE_CODES.join(', ')}`,
          ),
        includeHidden,
      },
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const report = await runHealthCheck(
          client,
          {
            client: args.client,
            serials: splitList(args.serials),
            includeHidden: args.includeHidden,
            criticalOnly: args.criticalOnly,
            ignore: parseIssueCodes(args.ignore),
            thresholds: {
              snapshotMaxAgeHours: args.snapshotMaxAgeHours,
              offsiteMaxAgeHours: args.offsiteMaxAgeHours,
              screenshotMaxAgeDays: args.screenshotMaxAgeDays,
              deviceOfflineHours: args.deviceOfflineHours,
              localStorageMaxPercent: args.localStorageMaxPercent,
              serviceExpiryWarnDays: args.serviceExpiryWarnDays,
            },
          },
          config.concurrency,
        );
        // dedupKey is for n8n; the LLM does not need it.
        return { ...report, findings: report.findings.map(({ dedupKey: _k, ...f }) => compact(f)) };
      }),
  );

  server.registerTool(
    'find-asset',
    {
      title: 'Agent flottenweit finden',
      description:
        'Sucht einen geschützten Server/Agent oder Share über Hostname/FQDN auf allen Geräten und liefert Gerät, Kunde und Backup-Status.',
      inputSchema: {
        hostname: z.string().min(2).describe('Teilstring des Hostnamens oder FQDN'),
        client: clientFilter,
        includeHidden,
      },
      annotations: READ_ONLY,
    },
    ({ hostname, client: c, includeHidden: hidden }) =>
      guarded(async () => {
        const now = new Date();
        const q = hostname.toLowerCase();
        const scans = await scanFleet(
          client,
          { client: c, includeHidden: hidden },
          config.concurrency,
        );
        const matches = scans.flatMap(({ device, assets }) =>
          (assets ?? [])
            .filter((a) => `${assetName(a) ?? ''} ${a.fqdn ?? ''}`.toLowerCase().includes(q))
            .map((a) => ({
              serial: device.serialNumber,
              device: deviceName(device),
              client: clientName(device),
              model: device.model,
              asset: assetSummary(a, now),
            })),
        );
        const failed = scans.filter((s) => s.error).map((s) => s.device.serialNumber);
        return compact({ count: matches.length, matches, devicesNotScanned: failed });
      }),
  );

  server.registerTool(
    'get-screenshot-failures',
    {
      title: 'Fehlgeschlagene Screenshot-Verifications',
      description:
        'Agents, deren Screenshot-Verification in den letzten X Tagen fehlgeschlagen ist (letzter Versuch oder Backups im Zeitraum).',
      inputSchema: {
        days: z.number().positive().max(90).optional().describe('Zeitraum in Tagen (Standard: 7)'),
        client: clientFilter,
        includeHidden,
      },
      annotations: READ_ONLY,
    },
    ({ days = 7, client: c, includeHidden: hidden }) =>
      guarded(async () => {
        const now = new Date();
        const windowH = days * 24;
        const scans = await scanFleet(
          client,
          { client: c, includeHidden: hidden },
          config.concurrency,
        );
        const failures = scans.flatMap(({ device, assets }) =>
          (assets ?? [])
            .filter((a) => !isShare(a) && !a.isArchived)
            .flatMap((a) => {
              const inWindow = (a.backups ?? []).filter(
                (b) => (ageHours(backupTime(b), now) ?? Infinity) <= windowH,
              );
              const failedInWindow = inWindow.filter(backupScreenshotFailed).length;
              const lastFailed =
                a.lastScreenshotAttemptStatus === false &&
                (ageHours(screenshotAt(a), now) ?? Infinity) <= windowH;
              if (!lastFailed && failedInWindow === 0) return [];
              return [
                compact({
                  client: clientName(device),
                  serial: device.serialNumber,
                  device: deviceName(device),
                  asset: assetName(a),
                  os: a.os,
                  lastAttempt: ago(screenshotAt(a), now),
                  lastAttemptOk: a.lastScreenshotAttemptStatus,
                  failedInWindow: failedInWindow || undefined,
                  checkedInWindow: inWindow.length || undefined,
                }),
              ];
            }),
        );
        failures.sort((x, y) => (x.client ?? '').localeCompare(y.client ?? ''));
        return { days, count: failures.length, failures };
      }),
  );

  server.registerTool(
    'get-client-overview',
    {
      title: 'Backup-Status pro Kunde',
      description:
        'Rollup pro Kunde: Geräte (online/offline), geschützte Agents/Shares, Anzahl kritischer und Warn-Befunde, Ampelstatus. ' +
        "Gut für Monatsreports, QBRs und 'wie steht Kunde X da?'. Nutzt dieselben Schwellwerte wie get-backup-health-summary.",
      inputSchema: { client: clientFilter, includeHidden },
      annotations: READ_ONLY,
    },
    ({ client: c, includeHidden: hidden }) =>
      guarded(async () => {
        const now = new Date();
        const scans = await scanFleet(
          client,
          { client: c, includeHidden: hidden },
          config.concurrency,
        );
        const report = buildHealthReport(scans, {}, now);

        type Row = {
          client: string;
          status: 'rot' | 'gelb' | 'grün';
          devices: number;
          offline: number;
          agents: number;
          shares: number;
          paused: number;
          critical: number;
          warning: number;
          problems: string[];
        };
        const rows = new Map<string, Row>();
        const row = (name: string | null) => {
          const key = name ?? '(ohne Kunde)';
          let r = rows.get(key);
          if (!r) {
            r = {
              client: key,
              status: 'grün',
              devices: 0,
              offline: 0,
              agents: 0,
              shares: 0,
              paused: 0,
              critical: 0,
              warning: 0,
              problems: [],
            };
            rows.set(key, r);
          }
          return r;
        };

        for (const { device, assets } of scans) {
          const r = row(clientName(device));
          r.devices++;
          if (deviceSummary(device, now, offline).online === false) r.offline++;
          for (const a of assets ?? []) {
            if (a.isArchived) continue;
            if (isShare(a)) r.shares++;
            else r.agents++;
            if (a.isPaused) r.paused++;
          }
        }
        for (const f of report.findings) {
          const r = row(f.client);
          r[f.severity]++;
          if (r.problems.length < 5)
            r.problems.push(
              `${f.asset ?? f.device ?? f.serial}: ${f.issues.map((i) => i.code).join(', ')}`,
            );
        }
        const list = [...rows.values()].map((r) => ({
          ...r,
          status: r.critical ? ('rot' as const) : r.warning ? ('gelb' as const) : ('grün' as const),
        }));
        const rank = { rot: 0, gelb: 1, grün: 2 };
        list.sort((x, y) => rank[x.status] - rank[y.status] || x.client.localeCompare(y.client));
        return {
          checkedAt: report.checkedAt,
          clients: list.length,
          byStatus: {
            rot: list.filter((r) => r.status === 'rot').length,
            gelb: list.filter((r) => r.status === 'gelb').length,
            grün: list.filter((r) => r.status === 'grün').length,
          },
          overview: list.map((r) =>
            compact({
              ...r,
              offline: r.offline || undefined,
              paused: r.paused || undefined,
              critical: r.critical || undefined,
              warning: r.warning || undefined,
            }),
          ),
        };
      }),
  );

  server.registerTool(
    'get-screenshot',
    {
      title: 'Screenshot-Verification anzeigen',
      description:
        'Lädt das letzte Screenshot-Verification-Bild eines Agents, damit du siehst, warum der Boot-Test fehlschlug ' +
        '(Bluescreen, Login-Fenster, Updates, Black Screen). Gibt das Bild plus Status zurück.',
      inputSchema: {
        serial,
        asset: z
          .string()
          .min(1)
          .describe('Name/Hostname des Agents (Teilstring reicht, muss eindeutig sein)'),
      },
      annotations: READ_ONLY,
    },
    async ({ serial: s, asset }) => {
      try {
        const now = new Date();
        const q = asset.toLowerCase();
        const matches = (await client.listAssets(s)).filter(
          (a) => !isShare(a) && `${assetName(a) ?? ''} ${a.fqdn ?? ''}`.toLowerCase().includes(q),
        );
        if (matches.length !== 1) {
          const names = matches.map((a) => assetName(a)).join(', ');
          throw new Error(
            matches.length
              ? `Mehrdeutig, Treffer: ${names}`
              : `Kein Agent '${asset}' auf ${s} gefunden`,
          );
        }
        const a = matches[0];
        const shot = screenshotAt(a);
        const meta = compact({
          serial: s,
          asset: assetName(a),
          lastAttempt: ago(shot, now),
          ok: a.lastScreenshotAttemptStatus,
        });
        // Prefer the URL the API hands out; fall back to the per-epoch endpoint (unverified, used by other clients).
        const shotDate = toDate(shot);
        const url =
          a.lastScreenshotUrl ??
          (a.agentId && shotDate
            ? `device/${encodeURIComponent(s)}/asset/${encodeURIComponent(a.agentId)}/screenshot/${Math.floor(shotDate.getTime() / 1000)}`
            : null);
        if (!url)
          return json({ ...meta, image: 'Für diesen Agent liefert die API keine Screenshot-URL' });
        const img = await client.getImage(url);
        return {
          content: [
            { type: 'text', text: JSON.stringify(meta) },
            { type: 'image', data: img.data, mimeType: img.mimeType },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        };
      }
    },
  );

  return server;
}
