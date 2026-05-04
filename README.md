# Mirror Rotator

A self-hosted redirect controller that automatically routes visitors to the first healthy mirror domain. When a mirror is blocked by an ISP, the system detects the hang and skips it — with no operator intervention required.

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Architecture](#architecture)
3. [Redirect Flow (Detailed)](#redirect-flow-detailed)
4. [ISP Block Detection](#isp-block-detection)
5. [Admin Panel](#admin-panel)
6. [Setup & Installation](#setup--installation)
7. [Configuration Reference](#configuration-reference)
8. [Deployment](#deployment)
9. [Data Storage](#data-storage)

---

## How It Works

Visitors land on a single stable URL (the **controller page**). This page never changes — it's the link you share on WhatsApp, Viber, or any marketing channel.

Behind the scenes, the controller silently tests each of your mirror domains and redirects the visitor to the first one that responds. If a mirror is blocked by the visitor's ISP (which causes the connection to hang rather than return an error), the controller detects the hang via a configurable timeout and skips to the next mirror.

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
             │   GET /               │  ← Stable controller URL
             │   (React SPA loads)   │      (never changes)
             └────────────┬───────────┘
                          │
              ┌───────────▼────────────┐
              │  GET /api/mirrors      │  ← Fetch ordered mirror list
              │  (public endpoint)     │      + probe timeout setting
              └───────────┬────────────┘
                          │
              ┌───────────▼────────────────────────────────────┐
              │         CONCURRENT PROBE (browser)             │
              │                                                │
              │  mirror-1 ──fetch()──► responds in 0.8s ✓     │
              │  mirror-2 ──fetch()──► hangs (ISP block) ✗    │
              │  mirror-3 ──fetch()──► responds in 1.2s ✓     │
              │                                                │
              │  Winner = mirror-1 (lowest index, healthy)     │
              └───────────┬────────────────────────────────────┘
                          │
              ┌───────────▼────────────┐
              │  window.location       │  ← Redirect with all
              │  .replace(mirror-1     │     original query params
              │  + entry params)       │     preserved
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
      │         └─► Returns: [{ id, url }, ...] (enabled only, in priority order)
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
      │     │        ├─ Response received before timeout ──► ✓ HEALTHY
      │     │        └─ Timeout fires, abort() called   ──► ✗ BLOCKED
      │     └─────────────────────────────────────────────────────┘
      │
      ├─3─► Select winner
      │         │
      │         ├─ Any HEALTHY mirrors? ──► Pick lowest index (highest priority)
      │         └─ All BLOCKED?         ──► Show error + Retry button
      │
      └─4─► Redirect
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

ISP-level blocks rarely return an error. Instead, the connection hangs — the TCP handshake completes but no HTTP response ever arrives. Standard HTTP error checking misses this entirely.

```
Normal HTTP error (detected by status code):
  Browser ──SYN──► Server ──SYN-ACK──► Browser ──ACK──► Server
  Browser ──GET──────────────────────────────────────► Server
  Server ─────────────────────────── 403 Forbidden ──► Browser
                                     ↑ status code visible

ISP Block (NOT detected by status code — hangs silently):
  Browser ──SYN──► ISP blocks or drops packet ──► (no response)
  Browser ──GET──────────────────────────────────► (no response)
  Browser waits... waits... waits...
                                     ↑ no status code ever arrives

Mirror Rotator approach (timeout-based detection):
  Browser ──GET──► mirror ──► (no response for N ms)
                                     │
                              AbortController fires
                                     │
                              Mark as BLOCKED, skip
```

The `probeTimeoutMs` setting controls how long to wait before treating a mirror as blocked. Set it high enough to allow legitimate slow connections (TLS handshake, CDN cold start), but low enough to not make visitors wait too long.

| Timeout | Effect |
|---------|--------|
| Too low (< 3s) | Healthy mirrors may be falsely marked blocked on slow connections |
| Recommended (5–10s) | Balances detection speed with connection tolerance |
| Too high (> 15s) | Visitors wait a long time before failover kicks in |

---

## Admin Panel

Navigate to `/admin` to access the admin panel. Log in with the password set in your `.env` file.

### Section 1 — Mirror List Manager

```
┌─────────────────────────────────────────────────────────────┐
│ Mirror List                              [+ Add Mirror]      │
├─────────────────────────────────────────────────────────────┤
│ ⠿  Primary        mirror1.example.com    ●  [🗑]           │
│ ⠿  Backup 1       mirror2.example.com    ●  [🗑]           │
│ ⠿  Backup 2       mirror3.example.com    ○  [🗑]           │
│     (disabled — excluded from probe cycle)                  │
├─────────────────────────────────────────────────────────────┤
│                              [Save All Changes]  ✓ Saved    │
└─────────────────────────────────────────────────────────────┘
```

- **Drag handle (⠿)** — drag rows to reorder. Top row = highest priority (tried first)
- **Toggle (● / ○)** — disable a mirror to exclude it from probing without deleting it
- **Delete (🗑)** — remove a mirror permanently
- **Add Mirror** — expands an inline form; URL must start with `https://`
- Changes are **staged locally** and not saved until you click **Save All Changes**

### Section 2 — Timeout Configuration

```
┌─────────────────────────────────────────────────────────────┐
│ Timeout Configuration                                        │
│                                                             │
│ Probe timeout (ms)   [  5000  ]                             │
│ How long to wait for each mirror before treating it as      │
│ blocked by an ISP.                                          │
│                                                             │
│ [Save]  ✓ Saved                                             │
└─────────────────────────────────────────────────────────────┘
```

Valid range: **500 – 10000 ms**. The controller reads this value on every page load via the `X-Probe-Timeout-Ms` response header on `GET /api/mirrors`.

### Section 3 — Change History

Audit log of every mirror list and config change. Columns: **Action · Detail · Timestamp**. Newest first, capped at 50 entries.

```
┌──────────────────┬──────────────────────────────────┬─────────────────────┐
│ Action           │ Detail                           │ Timestamp           │
├──────────────────┼──────────────────────────────────┼─────────────────────┤
│ mirrors_updated  │ Added: mirror3.example.com       │ 1 May 2025 14:22    │
│ config_updated   │ probeTimeoutMs set to 5000ms     │ 1 May 2025 12:00    │
│ mirrors_updated  │ Removed: mirror0.example.com     │ 30 Apr 2025 09:15   │
└──────────────────┴──────────────────────────────────┴─────────────────────┘
```

### Section 4 — Redirect Log

Every visit to the controller page generates one log entry after the probe cycle completes.

```
┌──────────────────┬─────────────┬─────────────┬──────────────────┬──────────┐
│ Timestamp        │ IP          │ Result      │ Redirected To    │ Params   │
├──────────────────┼─────────────┼─────────────┼──────────────────┼──────────┤
│ 2 May 14:31      │ 91.108.4.1  │ ✓ redirected│ mirror1.example  │ ctag=abc │
│ 2 May 14:30      │ 185.76.2.9  │ ✗ all failed│ —                │ ref=vb   │
│ 2 May 14:28      │ 91.108.4.1  │ ✓ redirected│ mirror2.example  │ ctag=xyz │
└──────────────────┴─────────────┴─────────────┴──────────────────┴──────────┘
```

Columns:
- **IP** — visitor's IP address (or load balancer forwarded IP via `X-Forwarded-For`)
- **Result** — `✓ redirected` (visitor reached a mirror) or `✗ all failed` (all mirrors were blocked)
- **Redirected To** — hostname of the mirror they landed on
- **Entry Params** — query string from the original entry URL (e.g. tracking tags)

Capped at 500 entries. Use **Refresh** to poll for new entries.

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

### Admin-Configurable Settings

| Setting | Range | Default | Description |
|---------|-------|---------|-------------|
| `probeTimeoutMs` | 500–10000 | 3000 | Milliseconds to wait for each mirror before marking it blocked |

### Mirror Fields

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (auto-generated when added via admin) |
| `url` | Full `https://` URL of the mirror |
| `label` | Operator-facing name (never shown to visitors) |
| `enabled` | `true` = included in probe cycle; `false` = skipped |

Mirror order in the list = probe priority. The first enabled mirror that responds wins.

---

## Deployment

### Production (Express + nginx/Caddy)

```bash
# Build the React frontend
npm run build          # outputs to /dist

# Start the server (serves /dist as static + /api routes)
npm start
```

Put nginx or Caddy in front for TLS:

```nginx
server {
    listen 443 ssl;
    server_name controller.example.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

> The `X-Forwarded-For` header is used to log the real visitor IP in the redirect log.

### Zero-Downtime Mirror Updates

Because all configuration is stored in `data/store.json` and read on every request, you can add, remove, or reorder mirrors via the admin panel with **no server restart required**. Changes take effect on the next visitor page load.

```
Add mirror in /admin → Save → Next visitor GET /api/mirrors → new mirror included
```

---

## Data Storage

All state is stored in `data/store.json`. This file is gitignored and should be excluded from deployments (it's created automatically on first run).

```json
{
  "mirrors": [
    {
      "id": "m1",
      "url": "https://mirror1.example.com",
      "label": "Primary",
      "enabled": true
    }
  ],
  "config": {
    "probeTimeoutMs": 5000,
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
      "entryParams": "ctag=abc"
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

- The admin password is checked server-side on every protected request — the token alone is not enough if the password changes
- Tokens expire after **8 hours** and must be re-issued via `/api/login`
- `POST /api/login` is rate-limited to **10 attempts per IP per minute**
- Mirror URLs are validated as `https://` both client-side and server-side — `http://` URLs are rejected
- The public `GET /api/mirrors` response never includes labels, `enabled` flags, or any operator metadata
- Run behind nginx or Caddy with TLS in production — never expose Express directly on port 80/443
# rotator
