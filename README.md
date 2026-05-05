# Mirror Rotator

A self-hosted redirect controller that automatically routes visitors to the first healthy mirror domain. When a mirror is blocked by an ISP, the system detects the block and skips it — with no operator intervention required.

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Architecture](#architecture)
3. [Redirect Flow (Detailed)](#redirect-flow-detailed)
4. [ISP Block Detection](#isp-block-detection)
5. [Admin Panel](#admin-panel)
6. [API Reference](#api-reference)
7. [Setup & Installation](#setup--installation)
8. [Configuration Reference](#configuration-reference)
9. [Deployment](#deployment)
10. [Data Storage](#data-storage)
11. [Security Notes](#security-notes)

---

## How It Works

Visitors land on a single stable URL (the **controller page**). This page never changes — it's the link you share on WhatsApp, Viber, or any marketing channel.

Behind the scenes, the controller tests each mirror domain and redirects the visitor to the first one that responds. If a mirror is blocked by the visitor's ISP (causing the connection to hang), the controller detects the hang via a configurable timeout and skips to the next mirror.

```
You share one stable link → visitor lands on controller → probe all mirrors →
redirect to first healthy mirror → visitor arrives at the real site
```

The visitor sees a brief loading spinner and lands on the destination. No mirror URLs are ever visible to them.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        VISITOR TRAFFIC                          │
│            (WhatsApp / Viber / Telegram / Email link)           │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
             ┌────────────────────────┐
             │   GET /               │  <- Stable controller URL
             │   (React SPA loads)   │      (never changes)
             └────────────┬───────────┘
                          │
              ┌───────────▼────────────┐
              │  GET /api/mirrors      │  <- Fetch ordered mirror list
              │  (public endpoint)     │      + probe timeout setting
              └───────────┬────────────┘
                          │
              ┌───────────▼────────────────────────────────────┐
              │         CONCURRENT PROBE (browser)             │
              │                                                │
              │  mirror-1 --fetch()--> responds in 0.8s  [OK] │
              │  mirror-2 --fetch()--> hangs (ISP block) [--] │
              │  mirror-3 --fetch()--> responds in 1.2s  [OK] │
              │                                                │
              │  Winner = mirror-1 (lowest index, healthy)     │
              └───────────┬────────────────────────────────────┘
                          │
              ┌───────────▼────────────┐
              │  POST /api/log         │  <- Fire-and-forget log
              │  window.location       │     (keepalive: true,
              │  .replace(mirror-1     │      survives navigation)
              │  + entry params)       │
              └───────────┬────────────┘
                          │
                          ▼
             ┌────────────────────────┐
             │  Visitor arrives at    │
             │  mirror-1.example.com  │
             └────────────────────────┘
```

---

## Redirect Flow (Detailed)

```
Browser loads /
      │
      ├─1─► Fetch GET /api/mirrors
      │         │
      │         └─► Returns: [{ id, url }, ...] (enabled + not server-blocked, in priority order)
      │             Header: X-Probe-Timeout-Ms: <configured ms>
      │
      ├─2─► Launch concurrent probes (all at once, not sequential)
      │
      │     For EACH mirror simultaneously:
      │     ┌─────────────────────────────────────────────────────┐
      │     │  Create AbortController                             │
      │     │  Set abort timer = probeTimeoutMs                   │
      │     │                                                     │
      │     │  fetch(mirrorUrl, { mode: 'no-cors' })              │
      │     │        │                                            │
      │     │        ├─ Response received before timeout --> HEALTHY
      │     │        └─ Timeout fires, abort() called   --> BLOCKED
      │     └─────────────────────────────────────────────────────┘
      │
      ├─3─► Select winner
      │         │
      │         ├─ Any HEALTHY mirrors? --> Pick lowest index (highest priority)
      │         └─ All BLOCKED?         --> Show error + Retry button
      │
      ├─4─► POST /api/log (fire-and-forget, keepalive: true)
      │         │
      │         └─► Logs: IP, UA, result, redirectedTo, entryParams,
      │                   per-mirror probe results (id, url, healthy, reason)
      │
      └─5─► Redirect
                │
                ├─ Read entry URL query params (?ctag=abc&ref=xyz)
                ├─ Merge into winner URL (don't overwrite existing mirror params)
                └─ window.location.replace(finalUrl)
                       │
                       └─► Controller page removed from browser history
```

### Query Parameter Preservation

All query parameters from the original entry link are forwarded to the mirror:

```
Entry URL:   https://controller.example.com/?ctag=abc123&ref=campaign
Mirror URL:  https://mirror1.example.com/
Final URL:   https://mirror1.example.com/?ctag=abc123&ref=campaign

If mirror already has params:
Mirror URL:  https://mirror1.example.com/?lang=en
Final URL:   https://mirror1.example.com/?lang=en&ctag=abc123&ref=campaign
             (mirror's own params are never overwritten)
```

---

## ISP Block Detection

The system uses a **two-layer detection** approach. Client-side probing detects connection hangs; server-side probing detects HTTP-level blocks including block pages with Russian-language content.

### Layer 1 — Client-Side Timeout Detection (visitor's browser)

ISP-level blocks rarely return an error. Instead, the connection hangs — the TCP handshake may complete but no HTTP response arrives. Standard HTTP error checking misses this entirely.

```
Normal HTTP error (detected by status code):
  Browser --SYN--> Server --SYN-ACK--> Browser --ACK--> Server
  Browser --GET----------------------------------------> Server
  Server --------------------------------- 403 Forbidden --> Browser
                                           ^ status code visible

ISP Block (NOT detected by status code -- hangs silently):
  Browser --SYN--> ISP blocks or drops packet --> (no response)
  Browser --GET----------------------------------------> (no response)
  Browser waits... waits... waits...
                                           ^ no status code ever arrives

Mirror Rotator approach (timeout-based detection):
  Browser --GET--> mirror --> (no response for N ms)
                                           │
                                    AbortController fires
                                           │
                                    Mark as BLOCKED, skip
```

### Layer 2 — Server-Side Content Analysis (your server)

The admin panel's **Check All** button triggers `POST /api/probe`. Your server fetches each mirror directly and inspects the response:

- **HTTP 403 or 451** — access denied / unavailable for legal reasons
- **Block page body content** — reads up to 50KB of the response body and matches against a configurable list of regex patterns (Russian ISP phrases, generic block indicators)

```
Server --GET--> mirror-1 --> HTTP 200, normal page   --> healthy
Server --GET--> mirror-2 --> HTTP 451                --> blocked (http_status)
Server --GET--> mirror-3 --> HTTP 200, "Доступ ограничен..." --> blocked (body_match)
Server --GET--> mirror-4 --> No response in 12s      --> timeout
```

Server-side status is stored per mirror and displayed as a badge in the Mirror Manager. Mirrors marked as `blocked` by the server are excluded from the public `GET /api/mirrors` response automatically.

### Probe Timeout Setting

The `probeTimeoutMs` setting controls how long the **client-side** probe waits before treating a mirror as blocked.

| Timeout | Effect |
|---------|--------|
| Too low (< 3s) | Healthy mirrors may be falsely marked blocked on slow connections |
| Recommended (5–10s) | Balances detection speed with connection tolerance |
| Too high (> 15s) | Visitors wait a long time before failover kicks in |

---

## Admin Panel

Navigate to `/admin` to access the admin panel. Log in with the password set in your `.env` file.

### Section 1 — Mirror Manager

```
┌─────────────────────────────────────────────────────────────────┐
│ Mirror List                    [Check All]  [+ Add Mirror]       │
├─────────────────────────────────────────────────────────────────┤
│ ⠿  Primary    [healthy]  mirror1.example.com    (on)  [delete]  │
│ ⠿  Backup 1   [blocked]  mirror2.example.com    (on)  [delete]  │
│ ⠿  Backup 2   [timeout]  mirror3.example.com   (off)  [delete]  │
│     (disabled -- excluded from probe cycle)                     │
├─────────────────────────────────────────────────────────────────┤
│                                         [Save All Changes]      │
└─────────────────────────────────────────────────────────────────┘
```

- **Drag handle (⠿)** — drag rows to reorder. Top row = highest priority (tried first)
- **Server status badge** — colour-coded result of the last server-side probe:
  - `healthy` (green) — server reached the mirror successfully
  - `blocked` (red) — server received a block response (403/451 or block page content)
  - `timeout` (yellow) — server probe timed out
  - `error` (grey) — probe failed (DNS, network error)
  - No badge — mirror has never been probed from the server
- **Toggle** — disable a mirror to exclude it from the probe cycle without deleting it
- **Delete** — remove a mirror permanently
- **Add Mirror** — expands an inline form; URL must start with `https://`
- **Check All** — runs a server-side probe against all mirrors immediately; updates badges
- Changes are **staged locally** and not saved until you click **Save All Changes**

### Section 2 — Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│ Configuration                                                    │
│                                                                 │
│ Probe timeout (ms)         [  5000  ]                           │
│ Alert webhook URL          [  https://hooks.example.com/...  ]  │
│ Alert threshold            [  3     ]                           │
│                                                                 │
│ [Save]  Saved                                                   │
└─────────────────────────────────────────────────────────────────┘
```

- **Probe timeout** — how long the visitor's browser waits per mirror (500–10000 ms)
- **Alert webhook URL** — optional URL to POST to when healthy mirrors drop to/below the threshold. Leave blank to disable.
- **Alert threshold** — number of healthy mirrors at or below which an alert fires (1–20)

**Webhook payload** (sent as JSON POST):

```json
{
  "event": "mirrors_low",
  "available": 2,
  "total": 5,
  "threshold": 3,
  "siteName": "YourBrand",
  "timestamp": "2025-05-02T14:31:00Z"
}
```

`event` is `"mirrors_empty"` when `available` is 0, otherwise `"mirrors_low"`.

### Section 3 — Block Pattern Editor

```
┌─────────────────────────────────────────────────────────────────┐
│ Block Pattern Editor                                            │
│                                                                 │
│  доступ.*ограничен                                    [edit] [x]│
│  ресурс.*заблокирован                                 [edit] [x]│
│  сайт.*недоступен                                     [edit] [x]│
│  ...                                                            │
│                                                                 │
│  [+ Add Pattern]                                                │
│                                [Save Patterns]                  │
└─────────────────────────────────────────────────────────────────┘
```

Regex patterns used by the **server-side** probe to detect block pages by body content. Each pattern is a JavaScript-compatible regex string (case-insensitive). The server matches against the first 50KB of each mirror's response body.

- **Edit** — click to edit inline; press Enter to confirm, Escape to cancel
- **Delete (x)** — remove a pattern
- **Add Pattern** — adds a new regex; validated before saving
- **Save Patterns** — writes changes to the server

Default patterns cover common Russian ISP block phrases and generic indicators (`access denied`, `blocked by`, etc.).

### Section 4 — Change History

Audit log of every mirror list and config change. Newest first, capped at 50 entries.

```
┌──────────────────┬──────────────────────────────────┬─────────────────────┐
│ Action           │ Detail                           │ Timestamp           │
├──────────────────┼──────────────────────────────────┼─────────────────────┤
│ mirrors_updated  │ Added: mirror3.example.com       │ 1 May 2025 14:22    │
│ config_updated   │ probeTimeoutMs set to 5000ms     │ 1 May 2025 12:00    │
│ mirrors_updated  │ Removed: mirror0.example.com     │ 30 Apr 2025 09:15   │
└──────────────────┴──────────────────────────────────┴─────────────────────┘
```

### Section 5 — Redirect Log

Every visit to the controller page generates one log entry. Click any row to expand per-mirror probe details.

```
┌───────────────┬──────────────┬─────────────┬──────────────────┬──────────┐
│ Timestamp     │ IP           │ Result      │ Redirected To    │ Params   │
├───────────────┼──────────────┼─────────────┼──────────────────┼──────────┤
│ 2 May 14:31   │ 91.108.4.1   │ redirected  │ mirror1.example  │ ctag=abc │
│ 2 May 14:30   │ 185.76.2.9   │ all_failed  │ —                │ ref=vb   │
└───────────────┴──────────────┴─────────────┴──────────────────┴──────────┘

Expanded row:
  ├── mirror-1  https://mirror1.example.com  healthy
  ├── mirror-2  https://mirror2.example.com  blocked: connection timed out after 5000ms
  └── mirror-3  https://mirror3.example.com  blocked: connection timed out after 5000ms
```

Columns:
- **IP** — visitor's IP address (or load balancer forwarded IP via `X-Forwarded-For`)
- **Result** — `redirected` (visitor reached a mirror) or `all_failed` (all mirrors blocked)
- **Redirected To** — hostname of the mirror they landed on
- **Entry Params** — query string from the original entry URL (e.g. tracking tags)
- **Expanded detail** — per-mirror result with reason for each blocked/failed mirror

Capped at 500 entries. Use **Refresh** to poll for new entries.

---

## API Reference

### Public Endpoints

#### `GET /api/mirrors`

Returns the ordered mirror list for the controller page.

- Bot user-agents (curl, wget, Python, Go HTTP client, Scrapy, etc.) receive `403 Forbidden`
- If `CONTROLLER_TOKEN` is set, requests must include `X-Controller-Token: <token>` header; missing/invalid token receives `403`
- If a valid admin `Authorization: Bearer <token>` is present, returns the full mirror list with all fields
- Otherwise returns only enabled, non-server-blocked mirrors with `id` and `url` fields only

Response headers:
```
X-Probe-Timeout-Ms: 5000
```

Response body (public):
```json
[
  { "id": "m1", "url": "https://mirror1.example.com" },
  { "id": "m3", "url": "https://mirror3.example.com" }
]
```

#### `POST /api/log`

Accepts a redirect log entry from the controller page. Fire-and-forget — errors are silently ignored by the client.

Request body:
```json
{
  "result": "redirected",
  "redirectedTo": "https://mirror1.example.com/?ctag=abc",
  "mirrorId": "m1",
  "entryParams": "ctag=abc",
  "mirrorResults": [
    { "id": "m1", "url": "https://mirror1.example.com", "healthy": true, "reason": null },
    { "id": "m2", "url": "https://mirror2.example.com", "healthy": false, "reason": "connection timed out after 5000ms" }
  ]
}
```

#### `POST /api/login`

Rate-limited to 10 attempts per IP per minute.

Request body:
```json
{ "password": "your-admin-password" }
```

Response:
```json
{ "token": "<jwt>" }
```

### Protected Endpoints (require `Authorization: Bearer <token>`)

#### `GET /api/mirrors` (with auth)

Returns the full mirror list including `label`, `enabled`, `serverStatus`, `serverStatusReason`, and `serverStatusAt` fields.

#### `POST /api/mirrors`

Save the full mirror list. Triggers a background probe of any newly added mirrors and fires webhook alerts if healthy count drops below threshold.

Request body:
```json
[
  { "id": "m1", "url": "https://mirror1.example.com", "label": "Primary", "enabled": true }
]
```

#### `GET /api/config`

Returns the current configuration object.

#### `POST /api/config`

Update configuration. All fields are optional — only provided fields are changed.

Request body:
```json
{
  "probeTimeoutMs": 5000,
  "alertWebhookUrl": "https://hooks.example.com/notify",
  "alertThreshold": 3,
  "blockPatterns": ["доступ.*ограничен", "access denied"]
}
```

#### `POST /api/probe`

Runs a server-side probe against all mirrors. Updates `serverStatus`, `serverStatusReason`, and `serverStatusAt` on each mirror. Fires webhook alerts if healthy count drops below threshold.

Response: updated full mirror array with server status fields.

#### `GET /api/history`

Returns the change history array (newest first, capped at 50).

#### `GET /api/log`

Returns the redirect log array (newest first, capped at 500).

---

## Setup & Installation

### Prerequisites

- Node.js 18+
- npm

### 1. Clone and install

```bash
git clone <your-repo>
cd mirror-rotator
npm run install:all   # installs server + client dependencies
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
ADMIN_PASSWORD=your-strong-password   # login password for /admin
JWT_SECRET=a-long-random-string       # signs session tokens (keep secret)
PORT=3000                             # optional, defaults to 3000
SITE_NAME=YourBrand                   # shown in admin panel header
CONTROLLER_TOKEN=                     # optional: restricts GET /api/mirrors
VITE_CONTROLLER_TOKEN=                # must match CONTROLLER_TOKEN (used by frontend build)
```

### 3. Run in development

```bash
npm run dev
```

This starts:
- **Express API** on `http://localhost:3000`
- **Vite dev server** on `http://localhost:5173` (proxies `/api` to Express)

Visit `http://localhost:5173/admin` to add your mirrors, then visit `http://localhost:5173/` to test the redirect.

---

## Configuration Reference

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_PASSWORD` | Yes | — | Password for the `/admin` login screen |
| `JWT_SECRET` | Yes | — | Secret used to sign admin session tokens (8h expiry) |
| `PORT` | No | `3000` | Port the Express server listens on |
| `SITE_NAME` | No | `Mirror Rotator` | Brand name shown in the admin header |
| `CONTROLLER_TOKEN` | No | — | If set, `GET /api/mirrors` requires `X-Controller-Token` header |
| `VITE_CONTROLLER_TOKEN` | No | — | Baked into the frontend build; must match `CONTROLLER_TOKEN` |

### Admin-Configurable Settings

| Setting | Range | Default | Description |
|---------|-------|---------|-------------|
| `probeTimeoutMs` | 500–10000 | 3000 | Milliseconds the browser waits per mirror before marking it blocked |
| `alertWebhookUrl` | Valid URL or blank | null | Webhook to POST when healthy mirror count drops to/below threshold |
| `alertThreshold` | 1–20 | 3 | Healthy mirror count that triggers an alert |
| `blockPatterns` | Array of regex strings | 14 defaults | Patterns matched against mirror response body during server-side probes |

### Mirror Fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (auto-generated when added via admin) |
| `url` | Full `https://` URL of the mirror |
| `label` | Operator-facing name (never shown to visitors) |
| `enabled` | `true` = included in probe cycle; `false` = skipped |
| `serverStatus` | Last server-side probe result: `healthy`, `blocked`, `timeout`, `error` |
| `serverStatusReason` | Human-readable reason for the last non-healthy result |
| `serverStatusAt` | ISO timestamp of the last server-side probe |

Mirror order in the list = probe priority. The first enabled, non-server-blocked mirror that responds wins.

---

## Deployment

### Option A — DigitalOcean (VPS + Caddy)

#### 1. Create a Droplet

- Ubuntu 22.04 LTS, minimum 1GB RAM
- Enable SSH key authentication

#### 2. Install dependencies

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# PM2
sudo npm install -g pm2
```

#### 3. Deploy the app

```bash
git clone <your-repo> /srv/mirror-rotator
cd /srv/mirror-rotator
npm run install:all
cp .env.example .env
# Edit .env with your values
nano .env
npm run build
```

#### 4. Start with PM2

```bash
pm2 start server/index.js --name mirror-rotator
pm2 save
pm2 startup   # follow the printed command to enable auto-restart on reboot
```

#### 5. Configure Caddy (automatic HTTPS)

Edit `/etc/caddy/Caddyfile`:

```
controller.example.com {
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-For {remote_host}
    }
}
```

```bash
sudo systemctl reload caddy
```

Caddy automatically provisions and renews TLS certificates.

#### 6. Point your domain

Add an A record for `controller.example.com` pointing to your Droplet's IP.

---

### Option B — Railway

Railway provides managed hosting with automatic deploys from GitHub and persistent volumes for `store.json`.

#### 1. Push to GitHub

```bash
git remote add origin https://github.com/youruser/mirror-rotator.git
git push -u origin main
```

#### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) and create a new project
2. Select **Deploy from GitHub repo** and choose your repository
3. Railway detects `railway.json` and uses the configured build and start commands automatically

#### 3. Add environment variables

In the Railway dashboard under **Variables**, add:

```
ADMIN_PASSWORD=your-strong-password
JWT_SECRET=a-long-random-string
SITE_NAME=YourBrand
CONTROLLER_TOKEN=optional-secret
VITE_CONTROLLER_TOKEN=optional-secret   # must match CONTROLLER_TOKEN
```

> `PORT` is set automatically by Railway — do not override it.

#### 4. Attach a persistent volume

Without a volume, `data/store.json` is wiped on every redeploy.

1. In your Railway service, go to **Settings > Volumes**
2. Click **Add Volume**
3. Set the mount path to `/app/data`
4. Redeploy

The `data/.gitkeep` file in the repo ensures the `data/` directory exists at build time for Railway to mount against.

#### 5. Add a custom domain

In **Settings > Domains**, add your custom domain and point your DNS to the Railway-provided CNAME.

---

### Zero-Downtime Mirror Updates

All configuration is stored in `data/store.json` and read on every request. Adding, removing, or reordering mirrors via the admin panel requires **no server restart**. Changes take effect on the next visitor page load.

```
Add mirror in /admin --> Save --> Next visitor GET /api/mirrors --> new mirror included
```

---

## Data Storage

All state is stored in `data/store.json`. This file is gitignored and created automatically on first run.

```json
{
  "mirrors": [
    {
      "id": "m1",
      "url": "https://mirror1.example.com",
      "label": "Primary",
      "enabled": true,
      "serverStatus": "healthy",
      "serverStatusReason": null,
      "serverStatusAt": "2025-05-01T12:00:00Z"
    }
  ],
  "config": {
    "probeTimeoutMs": 5000,
    "alertWebhookUrl": "https://hooks.example.com/notify",
    "alertThreshold": 3,
    "blockPatterns": [
      "доступ.*ограничен",
      "ресурс.*заблокирован",
      "..."
    ],
    "updatedAt": "2025-05-01T12:00:00Z"
  },
  "history": [
    {
      "action": "mirrors_updated",
      "detail": "Added: mirror1.example.com",
      "setAt": "2025-05-01T12:00:00Z",
      "setBy": "admin"
    }
  ],
  "redirectLog": [
    {
      "timestamp": "2025-05-02T14:31:00Z",
      "ip": "91.108.4.1",
      "userAgent": "Mozilla/5.0 ...",
      "result": "redirected",
      "redirectedTo": "https://mirror1.example.com/?ctag=abc",
      "mirrorId": "m1",
      "entryParams": "ctag=abc",
      "mirrorResults": [
        { "id": "m1", "url": "https://mirror1.example.com", "healthy": true, "reason": null },
        { "id": "m2", "url": "https://mirror2.example.com", "healthy": false, "reason": "connection timed out after 5000ms" }
      ]
    }
  ]
}
```

Writes are **atomic** — the file is written to a temp path and renamed, so a crash during a write never corrupts the stored data.

### Limits

| Collection | Cap | Behaviour when full |
|------------|-----|---------------------|
| `mirrors` | 20 | Rejected by API with 400 error |
| `history` | 50 | Oldest entry dropped |
| `redirectLog` | 500 | Oldest entry dropped |

---

## Security Notes

- The admin password is validated server-side on every protected request
- Tokens expire after **8 hours** and must be re-issued via `POST /api/login`
- `POST /api/login` is rate-limited to **10 attempts per IP per minute**
- Mirror URLs are validated as `https://` both client-side and server-side
- `GET /api/mirrors` filters out bot user-agents (curl, wget, Python, Go HTTP client, Scrapy, etc.)
- If `CONTROLLER_TOKEN` is set, `GET /api/mirrors` requires a matching `X-Controller-Token` header — this prevents casual scraping of your mirror list
- The public `GET /api/mirrors` response never includes labels, `enabled` flags, server status, or any operator metadata
- Server-side probes use a realistic browser User-Agent to avoid triggering bot detection on mirrors
- Run behind Caddy or nginx with TLS in production — never expose Express directly on port 80/443
