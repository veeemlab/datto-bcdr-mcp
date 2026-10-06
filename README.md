# Datto BCDR MCP Server

[![Release](https://github.com/veeemlab/datto-bcdr-mcp/actions/workflows/release.yml/badge.svg)](https://github.com/veeemlab/datto-bcdr-mcp/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@veeemlab/datto-bcdr-mcp?color=blue&label=npm)](https://www.npmjs.com/package/@veeemlab/datto-bcdr-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@veeemlab/datto-bcdr-mcp?color=blue)](https://www.npmjs.com/package/@veeemlab/datto-bcdr-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Docker Publish](https://github.com/veeemlab/datto-bcdr-mcp/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/veeemlab/datto-bcdr-mcp/pkgs/container/datto-bcdr-mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Datto BCDR** (SIRIS, ALTO, Cloud SIRIS/DBMA).
It lets MCP-compatible AI clients (Claude Desktop, Claude Code, and others) answer backup questions across your whole
fleet, such as _"Which backups are broken?"_ or _"How is customer X doing?"_, in **a single tool call**.

> **Read-only Datto BCDR MCP server that turns fleet-wide backup monitoring into one tool call.**

## Why this server?

Most Datto BCDR integrations wrap the REST API one endpoint at a time. The model then has to list every device,
fetch every agent and compare timestamps itself, which is slow, burns context and breaks on rate limits.
This server takes a different approach:

- **Aggregated tools, not just wrappers.** The health check runs server-side across all devices and returns **only the problems**.
- **Root causes, not just symptoms.** Besides stale snapshots it detects full local storage, an expiring Datto service period, paused agents, failed local verification and excluded volumes.
- **Context-friendly output.** Trimmed fields, relative timestamps ("vor 30 h"), empty values removed.
- **Rate-limit safe.** A sliding-window limiter keeps fleet scans under Datto's roughly 120 requests/minute per key, with a short GET cache and `Retry-After` handling.
- **Strictly read-only.** The server only issues `GET` requests. There is nothing to confirm because nothing can be changed.

## When to use this

Use this server when an MCP client should monitor Datto BCDR backups without hand-walking the API.

It is especially suited for:

- daily backup checks ("what failed overnight?")
- per-client status for monthly reports and QBRs
- finding a protected server by hostname across all appliances
- reviewing failed screenshot verifications, including the image
- automated alerting (e.g. an n8n cron job that opens PSA tickets via the REST endpoint)
- containerized MCP deployments

## Features

- **10 tools**, 2 of them fleet-wide aggregations (health summary, client overview)
- **11 health checks** with per-call threshold overrides, `ignore` and `criticalOnly`
- **Screenshot verification images** returned as MCP image content, so the model can see _why_ a boot test failed
- **Flat tool schemas** (string / number / boolean only), compatible with Copilot Studio and MCP hubs
- **Two transports:** `stdio` (default, for desktop/CLI clients) and authenticated **Streamable HTTP** for remote/containerized use
- **REST endpoint** `/api/health-summary` with stable `dedupKey`s for ticket deduplication
- Field names verified against the live Datto BCDR API

## Tools (10)

| Tool                            | Description                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------- |
| **`get-backup-health-summary`** | Checks all devices and agents against thresholds and returns **only findings**    |
| **`get-client-overview`**       | Per-client rollup: devices, agents, critical/warning counts, traffic-light status |
| `find-asset`                    | Find a protected server/agent by hostname across the whole fleet                  |
| `get-screenshot-failures`       | Agents whose screenshot verification failed in the last N days                    |
| `get-screenshot`                | Latest screenshot verification image of an agent                                  |
| `list-alerts`                   | Active alerts, per device or fleet-wide                                           |
| `list-active-restores`          | Running virtualizations / VM restores, per device or fleet-wide                   |
| `list-devices`                  | Fleet with model, client and online status                                        |
| `get-device`                    | Device details incl. local storage usage in %, service period and warranty        |
| `list-device-assets`            | Agents/shares of a device with snapshot, offsite, screenshot and backup status    |

All tools are read-only. Tool descriptions and finding texts are in German.

### Health checks

| Code                                     | Severity                       | Default                                                 |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| `DEVICE_OFFLINE`                         | critical                       | not seen for > 1 h                                      |
| `SNAPSHOT_STALE` / `SNAPSHOT_MISSING`    | critical                       | last snapshot > 24 h ago / none                         |
| `BACKUP_FAILED`                          | critical                       | last backup run failed (incl. error message)            |
| `LOCAL_STORAGE_HIGH`                     | warning, critical from 95 %    | ≥ 85 % used                                             |
| `SERVICE_EXPIRING`                       | warning, critical once expired | Datto service period ends within 30 days                |
| `LOCAL_VERIFICATION_FAILED`              | warning                        | backup succeeded but local verification failed          |
| `OFFSITE_STALE` / `OFFSITE_MISSING`      | warning                        | last offsite sync > 48 h ago / never (not for CLDSIRIS) |
| `SCREENSHOT_FAILED` / `SCREENSHOT_STALE` | warning                        | last attempt failed / older than 7 days                 |
| `AGENT_PAUSED`                           | warning                        | agent is paused (forgotten pauses after maintenance)    |
| `UNPROTECTED_VOLUMES`                    | warning                        | volumes excluded from the backup (named)                |
| `DEVICE_API_ERROR`                       | warning                        | assets of the device could not be fetched               |

Every threshold can be overridden per call. Use `ignore` (comma-separated codes) to hide specific checks and
`criticalOnly` to return critical findings only. Archived agents are skipped, shares have no screenshot check.
A paused agent is reported once as `AGENT_PAUSED` instead of its stale-snapshot symptoms.

## Prerequisites

- **Node.js 20+**
- **Datto BCDR API key pair**: Partner Portal → Admin → Integrations → API Keys → Create API Key.
  Create it **without a client or vendor restriction**, otherwise the key only sees part of the fleet.
  Datto allows at most two API keys per organization.

## Installation

### 1. Run via `npx` (recommended)

```bash
npx -y @veeemlab/datto-bcdr-mcp
```

### 2. Run from GitHub (bleeding edge)

```bash
npx -y github:veeemlab/datto-bcdr-mcp
```

### 3. Install globally

```bash
npm install -g @veeemlab/datto-bcdr-mcp
datto-bcdr-mcp
```

## Configuration

### MCP hubs (stdio)

| Field       | Value                                            |
| ----------- | ------------------------------------------------ |
| Server type | STDIO                                            |
| Command     | `npx`                                            |
| Arguments   | `-y @veeemlab/datto-bcdr-mcp@0.1.0`              |
| Environment | `DATTO_BCDR_PUBLIC_KEY`, `DATTO_BCDR_SECRET_KEY` |

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "datto-bcdr": {
      "command": "npx",
      "args": ["-y", "@veeemlab/datto-bcdr-mcp"],
      "env": {
        "DATTO_BCDR_PUBLIC_KEY": "your-public-key",
        "DATTO_BCDR_SECRET_KEY": "your-secret-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add datto-bcdr --env DATTO_BCDR_PUBLIC_KEY=your-public-key --env DATTO_BCDR_SECRET_KEY=your-secret-key -- npx -y @veeemlab/datto-bcdr-mcp
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector npx -y @veeemlab/datto-bcdr-mcp
```

All tool schemas are flat. List parameters such as `serials` or `ignore` take comma-separated strings,
e.g. `"AGENT_PAUSED,SCREENSHOT_STALE"`.

## Environment Variables

| Variable                           | Required  | Default                         | Description                                                                                     |
| ---------------------------------- | --------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATTO_BCDR_PUBLIC_KEY`            | yes       |                                 | Public key (Basic Auth username)                                                                |
| `DATTO_BCDR_SECRET_KEY`            | yes       |                                 | Secret key (Basic Auth password)                                                                |
| `MCP_TRANSPORT`                    | no        | `stdio`                         | `stdio` or `http`                                                                               |
| `DATTO_BCDR_CONCURRENCY`           | no        | `5`                             | Parallel requests during fleet scans                                                            |
| `DATTO_BCDR_RATE_LIMIT_PER_MINUTE` | no        | `100`                           | Datto allows roughly 120/min per key                                                            |
| `DATTO_BCDR_CACHE_TTL_SECONDS`     | no        | `60`                            | GET cache TTL, `0` disables it                                                                  |
| `DATTO_BCDR_TIMEOUT_MS`            | no        | `30000`                         | Timeout per request                                                                             |
| `DATTO_BCDR_BASE_URL`              | no        | `https://api.datto.com/v1/bcdr` |                                                                                                 |
| `MCP_AUTH_TOKEN`                   | HTTP only |                                 | Bearer token for `/mcp` and `/api`. Always set it when the server is reachable from the network |
| `HOST` / `PORT`                    | HTTP only | `127.0.0.1` / `3000`            |                                                                                                 |
| `ALLOWED_HOSTS`                    | HTTP only |                                 | Host header allowlist (DNS rebinding protection), e.g. `mcp.example.com`                        |

## Run with Docker

Images for `linux/amd64` and `linux/arm64` are published to GHCR on every release.

**stdio** (Claude Desktop/Code, MCP hubs):

```bash
docker run -i --rm -e DATTO_BCDR_PUBLIC_KEY=... -e DATTO_BCDR_SECRET_KEY=... ghcr.io/veeemlab/datto-bcdr-mcp:latest
```

**HTTP** (long-running service): use the included [docker-compose.yml](docker-compose.yml) with a `.env` file
containing the Datto keys and `MCP_AUTH_TOKEN`.

```bash
docker compose up -d
```

Without Docker: `npm run start:http`. In HTTP mode the server refuses to start without `MCP_AUTH_TOKEN`
unless `HOST` is a loopback address.

| Path                      | Purpose                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST /mcp`               | MCP Streamable HTTP (stateless), `Authorization: Bearer $MCP_AUTH_TOKEN`                                              |
| `GET /api/health-summary` | Plain JSON health report, same parameters as query string (`?criticalOnly=true&ignore=AGENT_PAUSED,SCREENSHOT_STALE`) |
| `GET /healthz`            | Liveness probe, no auth                                                                                               |

```bash
curl -s localhost:3000/api/health-summary -H "Authorization: Bearer $MCP_AUTH_TOKEN" | jq .totals
```

### Automation (e.g. n8n → PSA tickets)

`GET /api/health-summary` returns a `dedupKey` per finding (`<serial>:<asset>` or `<serial>:_device`).
Before opening a ticket, the workflow looks for an open ticket with that key (e.g. in the title or a custom field)
and only creates a new one if none exists.

## Security

- Read-only: the server only issues `GET` requests to the Datto API.
- Credentials are read from environment variables only and never logged.
- Screenshot images are only downloaded from `https://*.datto.com` / `https://*.dattobackup.com`, and API credentials are only sent to the API host.
- In HTTP mode a bearer token is mandatory on non-loopback hosts. Use `ALLOWED_HOSTS` to pin the expected host name behind a reverse proxy.

## Development

```bash
npm ci
cp .env.example .env   # add your keys
set -a; source .env; set +a
npm run smoke          # validates the key pair and prints the real field names of /device and /asset
npm run lint           # eslint
npm run format:check   # prettier
npm test               # vitest
npm run inspect        # MCP Inspector against dist/
```

## Release

Releases are tag-driven. On a `v*` tag the workflows run lint, tests and build, publish to npm with provenance,
create a GitHub release and push the Docker image to GHCR:

```bash
npm version patch && git push --follow-tags
```

## License

MIT
