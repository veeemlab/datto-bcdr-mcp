/**
 * Smoke test against the real API: validates the key pair and prints the actual field names of
 * /device and /asset so they can be compared with the assumed shapes in datto-client.ts.
 *
 *   DATTO_BCDR_PUBLIC_KEY=... DATTO_BCDR_SECRET_KEY=... npm run smoke [-- <serial>]
 */
import { loadConfig } from './config.js';
import { DattoBcdrClient, type RawAsset } from './datto-client.js';

const client = new DattoBcdrClient({ ...loadConfig(), cacheTtlMs: 0 });

const devices = await client.listDevices();
console.log(`OK: ${devices.length} devices visible to this key`);
console.table(
  devices.slice(0, 10).map((d) => ({
    serial: d.serialNumber,
    name: d.name ?? d.hostname,
    model: d.model,
    client: d.clientCompanyName,
  })),
);

const models = [...new Set(devices.map((d) => d.model))];
console.log('Models:', models.join(', '));

const serial = process.argv[2] ?? devices[0]?.serialNumber;
if (!serial) process.exit(0);

const device = await client.getDevice(serial);
console.log(`\n/device/${serial} fields:`, Object.keys(device).sort().join(', '));

const assets = await client.listAssets(serial);
console.log(`/device/${serial}/asset: ${assets.length} assets`);
const first: RawAsset | undefined = assets[0];
if (first) {
  console.log('asset fields:', Object.keys(first).sort().join(', '));
  const { backups, ...rest } = first;
  console.log('first asset (without backups):', JSON.stringify(rest, null, 2));
  if (backups?.[0]) console.log('first backup entry:', JSON.stringify(backups[0], null, 2));
}

const alerts = await client.listAlerts(serial);
console.log(
  `/device/${serial}/alert: ${alerts.length} alerts`,
  alerts[0] ? Object.keys(alerts[0]).join(', ') : '',
);
