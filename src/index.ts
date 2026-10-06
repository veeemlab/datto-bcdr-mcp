#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { DattoBcdrClient } from './datto-client.js';
import { parseIssueCodes, runHealthCheck, splitList } from './health.js';
import { createServer } from './tools.js';

const config = loadConfig();
const client = new DattoBcdrClient(config);

const transport = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase();
if (transport === 'http') {
  startHttp();
} else if (transport === 'stdio') {
  // Default, so `npx -y @veeemlab/datto-bcdr-mcp` works in Claude Desktop and MCP hubs.
  // stdout belongs to the protocol, so log to stderr only.
  await createServer(client, config).connect(new StdioServerTransport());
  console.error('datto-bcdr-mcp running on stdio');
} else {
  console.error(`Unknown MCP_TRANSPORT "${transport}", expected "stdio" or "http"`);
  process.exit(1);
}

function startHttp(): void {
  // Backup data must never be exposed unauthenticated: a token is mandatory unless bound to loopback.
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(config.host);
  if (!config.authToken && !loopback) {
    console.error(`MCP_AUTH_TOKEN is required when HOST is not loopback (HOST=${config.host}).`);
    process.exit(1);
  }

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts.length ? config.allowedHosts : undefined,
  });

  const digest = (s: string) => createHash('sha256').update(s).digest();
  const expected = config.authToken ? digest(config.authToken) : null;

  function requireToken(req: Request, res: Response, next: NextFunction): void {
    if (!expected) return next();
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token && timingSafeEqual(digest(token), expected)) return next();
    res.status(401).json({ error: 'unauthorized' });
  }

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, no session affinity needed behind the proxy.
  app.post('/mcp', requireToken, async (req, res) => {
    const server = createServer(client, config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  /**
   * Plain JSON endpoint for automation (e.g. an hourly n8n cron that opens PSA tickets). Same logic as get-backup-health-summary,
   * but keeps dedupKey on every finding for ticket deduplication.
   */
  const num = z.coerce.number().positive().optional();
  const bool = z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true'));
  const healthQuery = z.object({
    client: z.string().optional(),
    serials: z.string().optional(),
    ignore: z.string().optional(),
    criticalOnly: bool,
    includeHidden: bool,
    snapshotMaxAgeHours: num,
    offsiteMaxAgeHours: num,
    screenshotMaxAgeDays: num,
    deviceOfflineHours: num,
    localStorageMaxPercent: num,
    serviceExpiryWarnDays: z.coerce.number().min(0).optional(),
  });

  app.get('/api/health-summary', requireToken, async (req, res) => {
    const parsed = healthQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: z.prettifyError(parsed.error) });
      return;
    }
    const q = parsed.data;
    let ignore;
    try {
      ignore = parseIssueCodes(q.ignore);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      const report = await runHealthCheck(
        client,
        {
          client: q.client,
          serials: splitList(q.serials),
          includeHidden: q.includeHidden,
          criticalOnly: q.criticalOnly,
          ignore,
          thresholds: {
            snapshotMaxAgeHours: q.snapshotMaxAgeHours,
            offsiteMaxAgeHours: q.offsiteMaxAgeHours,
            screenshotMaxAgeDays: q.screenshotMaxAgeDays,
            deviceOfflineHours: q.deviceOfflineHours,
            localStorageMaxPercent: q.localStorageMaxPercent,
            serviceExpiryWarnDays: q.serviceExpiryWarnDays,
          },
        },
        config.concurrency,
      );
      res.json(report);
    } catch (err) {
      console.error('health-summary failed:', err);
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(config.port, config.host, () => {
    console.log(
      `datto-bcdr-mcp listening on http://${config.host}:${config.port} (MCP: /mcp, n8n: /api/health-summary)`,
    );
    if (!config.authToken)
      console.warn(
        'Warning: MCP_AUTH_TOKEN is not set; endpoints are only reachable from localhost.',
      );
  });
}
