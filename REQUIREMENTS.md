# Domain Rotation Tool — Requirements v2

## Overview

A self-hosted web application that provides high-availability redirection for marketing
traffic. Visitors land on a stable controller page that silently fetches an ordered list of
candidate mirror domains, asynchronously probes each one for liveness using timeout-based
detection, and automatically redirects the browser to the first responsive mirror. All
original query parameters (e.g. tracking tags) are preserved through the redirect chain.

When a mirror gets blocked by an ISP, the connection hangs rather than returning an error —
the system detects this via configurable timeout thresholds and skips the blocked mirror
automatically, with no operator intervention required. The admin panel manages the mirror
list and timeout settings.

---

## Goals

- Automatically redirect visitors to the first healthy mirror without any click required
- Detect ISP-blocked mirrors via connection timeout (not just HTTP error status)
- Preserve all URL query parameters (e.g. `ctag`) through the full redirect chain
- Support an ordered list of multiple candidate mirrors with automatic failover
- Admin panel to add, remove, and reorder mirrors, and configure timeout thresholds
- Change history log so the operator can audit mirror list modifications
- Zero downtime when adding or removing mirrors — no code deployments needed
- Simple to self-host (single Node.js process or serverless edge)

## Non-Goals

- Telegram bot integration
- Crypto token display or purchasing
- Multi-user admin accounts (single shared password is sufficient)
- Server-side health monitoring (all health checks run client-side in the browser)

---

## Tech Stack

| Layer       | Choice                                      | Notes                                        |
|-------------|---------------------------------------------|----------------------------------------------|
| Frontend    | React + Vite                                | Single-page app                              |
| Styling     | Tailwind CSS                                | Utility-first, no component library needed   |
| Backend     | Node.js + Express **or** Cloudflare Workers | See Deployment section                       |
| Storage     | Cloudflare KV **or** JSON file on disk      | Key-value; no relational DB needed           |
| Auth        | Single password (env var)                   | Checked server-side on every admin request   |

---

## Architecture

```
User Traffic (WhatsApp / Viber / Telegram link)
  │
  └─► GET /                         ← Stable controller URL (never changes)
        │
        ├─ 1. Page loads (React SPA)
        │
        ├─ 2. Fetch GET /api/mirrors  ← Returns ordered array of candidate hosts
        │
        ├─ 3. Async probe each mirror with AbortController timeout
        │       ├─ Mirror responds within threshold → ✓ HEALTHY
        │       └─ Connection hangs past threshold  → ✗ BLOCKED (skip)
        │
        └─ 4. window.location.replace(first healthy mirror URL)
                + all original query params appended
                  (e.g. ?ctag=abc&ref=xyz preserved)


Admin traffic
  └─► GET /admin
        ├─ POST /api/login                → validates password, returns token
        ├─ GET  /api/mirrors              → returns mirror list (public)
        ├─ POST /api/mirrors              → replace full mirror list (protected)
        ├─ GET  /api/config               → returns timeout settings (protected)
        ├─ POST /api/config               → updates timeout settings (protected)
        └─ GET  /api/history              → returns change log (protected)
```

All API routes live under `/api`. The React SPA is served from `/`.

---

## Redirect Controller — Detailed Flow

This is the core logic that runs on the public landing page (`/`).

### Phase 1 — Discovery
On mount, the frontend calls `GET /api/mirrors` to retrieve the ordered array of enabled
candidate mirror URLs.

### Phase 2 — Verification (Timeout-Based Health Check)
The frontend probes all mirrors **simultaneously** using `fetch()` with an `AbortController`
tied to a configurable timeout (`probeTimeoutMs`, default 3000ms).

**Critical:** The system must detect ISP-level blocks, which manifest as **connection hangs**
rather than HTTP error responses. A mirror is considered blocked if the fetch does not settle
within `probeTimeoutMs`, regardless of what HTTP status it would eventually return.

```
For each mirror (all probed concurrently):
  - Start fetch() with AbortController
  - Set abort timer to probeTimeoutMs
  - If response received before timeout  → mark HEALTHY
  - If timeout fires before response     → abort + mark BLOCKED
  - If fetch throws a network error      → mark BLOCKED

Select the HEALTHY mirror with the lowest configured index (highest priority).
```

### Phase 3 — Parameter Retention
Before redirecting, the Query Handler captures all `URLSearchParams` from the current
page URL (the entry link the user originally clicked). These parameters must be appended
to the target mirror URL to preserve tracking integrity.

```
Entry URL:  https://controller.example.com/?ctag=abc123&ref=campaign1
Mirror URL: https://mirror3.example.com/
Final URL:  https://mirror3.example.com/?ctag=abc123&ref=campaign1
```

If the mirror URL already contains query parameters, merge them; do not overwrite existing
mirror params.

### Phase 4 — Execution
Perform `window.location.replace(finalUrl)` to navigate to the verified healthy mirror.
Use `replace()` (not `assign()`) so the controller page is not added to browser history.

### Fallback Behaviour
If **all** mirrors fail the health check:
- Do not redirect
- Show a neutral error message: *"We're having trouble reaching our servers. Please try
  again in a moment."*
- Show a **Retry** button that re-runs the full probe cycle from scratch
- Never expose mirror URLs or technical details in the error UI

---

## Data Model

### Mirror list
```json
[
  { "id": "m1", "url": "https://mirror1.example.com", "label": "Primary",   "enabled": true },
  { "id": "m2", "url": "https://mirror2.example.com", "label": "Backup 1",  "enabled": true },
  { "id": "m3", "url": "https://mirror3.example.com", "label": "Backup 2",  "enabled": false }
]
```
- Mirrors are probed in array order (index 0 = highest priority)
- `enabled: false` mirrors are excluded from the probe cycle entirely
- `label` is operator-facing only, never exposed in the public API response

### Config record
```json
{
  "probeTimeoutMs": 3000,
  "updatedAt": "2025-05-01T12:00:00Z"
}
```

### History entry
```json
{
  "action": "mirrors_updated",
  "detail": "Added mirror3.example.com; removed mirror0.example.com",
  "setAt": "2025-05-01T14:22:00Z",
  "setBy": "admin"
}
```

History is stored as an array, newest first, capped at 50 entries.

---

## API Specification

### `GET /api/mirrors`
- **Auth:** None (public — called by redirect controller on every page load)
- **Response 200:** Enabled mirrors only, in configured order
  ```json
  [
    { "id": "m1", "url": "https://mirror1.example.com" },
    { "id": "m2", "url": "https://mirror2.example.com" }
  ]
  ```
- Labels and `enabled` field are **not** included in the public response

### `POST /api/login`
- **Auth:** None
- **Body:** `{ "password": "..." }`
- **Response 200:** `{ "token": "<jwt>" }`
- **Response 401:** `{ "error": "Invalid password" }`
- Token sent as `Authorization: Bearer <token>` on all protected routes
- Token expiry: 8 hours

### `POST /api/mirrors`
- **Auth:** Bearer token required
- **Body:** Full mirror array (replaces existing list entirely)
  ```json
  [
    { "id": "m1", "url": "https://mirror1.example.com", "label": "Primary",  "enabled": true },
    { "id": "m2", "url": "https://mirror2.example.com", "label": "Backup 1", "enabled": false }
  ]
  ```
- **Validation:**
  - Each `url` must be a valid `https://` URL; reject `http://`
  - Maximum 20 mirrors per list
  - `id` values must be unique within the array
- **Response 200:** Saved mirror list (full, including labels and enabled flags)
- **Response 400:** `{ "error": "..." }`
- **Response 401:** Unauthorized

### `GET /api/config`
- **Auth:** Bearer token required
- **Response 200:** `{ "probeTimeoutMs": 3000, "updatedAt": "..." }`

### `POST /api/config`
- **Auth:** Bearer token required
- **Body:** `{ "probeTimeoutMs": 3000 }`
- **Validation:** Integer between 500 and 10000 (ms)
- **Response 200:** Updated config record
- **Response 400:** `{ "error": "probeTimeoutMs must be between 500 and 10000" }`

### `GET /api/history`
- **Auth:** Bearer token required
- **Response 200:** Array of history entries, newest first

---

## Frontend — Redirect Controller (`/`)

### Layout
- Full-viewport dark background
- Centered loading spinner / "Connecting…" message only
- No mirror URLs, domain names, or technical details visible to visitors at any point
- On successful redirect: browser navigates away immediately (no visible change)
- On all-mirrors-failed: neutral error message + Retry button

### Behaviour
1. On mount, fetch `GET /api/mirrors`
2. Run async probe cycle (Phase 2) using `AbortController`; timeout value bundled as a
   default (3000ms) — do **not** call `GET /api/config` at runtime to avoid extra latency
   on the critical redirect path
3. First HEALTHY mirror found → `window.location.replace(finalUrl)` with merged query params
4. Show spinner throughout; never reveal which mirrors are being tried
5. No "Admin" link on this page

---

## Frontend — Admin Dashboard (`/admin`)

### Login Screen
- Password input + Submit button
- Wrong password: inline error message, input field shakes animation
- Success: store token in `sessionStorage`, load dashboard view
- "← Back to site" link

### Dashboard View
Protected by token check on load. Redirect to login if token missing or expired.

#### Section 1 — Mirror List Manager
- Ordered list showing all mirrors (enabled and disabled)
- Each row: drag handle · label · URL · enabled toggle · delete button
- Drag-and-drop reordering (order = probe priority, top = highest)
- **Add Mirror** button: expands inline form with URL + Label inputs + Save/Cancel
- URL validated client-side (`https://` required) before allowing save
- Changes are staged locally and **not** persisted until **Save All Changes** is clicked
- On save: `POST /api/mirrors` with full updated array
- On success: "✓ Saved" inline confirmation for 3 seconds, Section 1 refreshes
- On error: inline error message

#### Section 2 — Timeout Configuration
- Number input: "Probe timeout (ms)" — valid range 500–10000
- Helper text: *"How long to wait for each mirror before treating it as blocked by an ISP."*
- **Save** button → `POST /api/config`
- On success: "✓ Saved" confirmation for 3 seconds

#### Section 3 — Change History
- Table columns: **Action**, **Detail**, **Timestamp**
- Newest entry first, maximum 50 rows displayed

#### Header
- Site name + "Admin Panel" label
- **Logout** button — clears `sessionStorage` token, redirects to `/`

---

## Backend — Express Implementation

### File Structure
```
/
├── server/
│   ├── index.js                  # Express entry point
│   ├── routes/
│   │   ├── auth.js               # POST /api/login
│   │   ├── mirrors.js            # GET/POST /api/mirrors
│   │   ├── config.js             # GET/POST /api/config
│   │   └── history.js            # GET /api/history
│   ├── middleware/
│   │   └── auth.js               # Bearer token validation
│   └── storage.js                # Atomic JSON read/write abstraction
├── client/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── pages/
│   │   │   ├── Controller.jsx    # Redirect controller (`/`)
│   │   │   └── Admin.jsx         # Admin dashboard (`/admin`)
│   │   ├── hooks/
│   │   │   └── useMirrorProbe.js # Async probe logic with AbortController
│   │   └── api.js                # Fetch wrapper for all API calls
│   └── vite.config.js
├── data/
│   └── store.json                # Persisted state (gitignored)
├── .env.example
└── package.json
```

### Environment Variables
```
ADMIN_PASSWORD=changeme        # Required. Checked server-side.
JWT_SECRET=random-secret       # Required. Signs session tokens.
PORT=3000                      # Optional. Defaults to 3000.
SITE_NAME=JetTon               # Optional. Shown in admin panel header.
```

### `data/store.json` Schema
```json
{
  "mirrors": [],
  "config": {
    "probeTimeoutMs": 3000,
    "updatedAt": "2025-01-01T00:00:00Z"
  },
  "history": []
}
```
Write atomically via temp-file rename to prevent corruption on concurrent writes.

---

## Alternative Backend — Cloudflare Workers

- KV namespace `URL_STORE`; keys: `mirrors`, `config`, `history` (all JSON strings)
- Worker handles all `/api/*` routes
- Static assets (React build) served from Cloudflare Pages
- Secrets set in the Cloudflare dashboard (same variable names as above)

---

## Security Requirements

- Admin password via environment variable — never hardcoded
- All admin routes validate Bearer token on every request
- Tokens expire after 8 hours
- `ADMIN_PASSWORD` must never appear in any API response
- URL validation (`https://` only) enforced server-side, not just client-side
- `POST /api/login` rate-limited to 10 attempts per IP per minute
- HTTPS enforced in production (Cloudflare automatic; Express behind nginx/Caddy with TLS)
- `GET /api/mirrors` public response must never include `label`, `enabled`, or any
  operator-facing metadata — only `id` and `url`

---

## Deployment

### Local Development
```bash
cp .env.example .env
npm install
npm run dev        # Vite (client) + nodemon (server) run concurrently
```

### Production (Express)
```bash
npm run build      # Vite builds client → /dist
npm start          # Express serves /dist as static + /api routes
```
Deploy behind nginx or Caddy for TLS termination.

### Production (Cloudflare)
```bash
npm run deploy     # wrangler build + publish
```

---

## Acceptance Criteria

### Redirect Controller
- [ ] Visiting `/` begins probing mirrors immediately — no user action required
- [ ] All enabled mirrors are probed concurrently, not sequentially
- [ ] A mirror that does not respond within `probeTimeoutMs` is skipped (marked blocked)
- [ ] A mirror returning any HTTP response within the timeout is treated as healthy
- [ ] Browser redirects to the highest-priority healthy mirror via `window.location.replace()`
- [ ] All query parameters from the entry URL are appended to the final redirect URL
- [ ] If the mirror already has query params, entry params are merged without overwriting
- [ ] If all mirrors fail, a neutral error message and Retry button are shown
- [ ] Retry button re-runs the full probe cycle from scratch
- [ ] No mirror URLs are ever visible to visitors in the UI
- [ ] Disabled mirrors are excluded from the probe cycle

### Admin — Mirror Management
- [ ] Visiting `/admin` without a token redirects to login
- [ ] Wrong password shows error, does not grant access
- [ ] Correct password issues a token and loads the dashboard
- [ ] Admin can add a mirror with a URL and label
- [ ] Adding a non-`https://` URL shows a validation error and is rejected
- [ ] Admin can toggle a mirror enabled/disabled
- [ ] Admin can reorder mirrors via drag-and-drop
- [ ] Admin can delete a mirror
- [ ] Changes are staged locally and not saved until "Save All Changes" is clicked
- [ ] After saving, `GET /api/mirrors` immediately returns the updated ordered list
- [ ] All mirror list changes are appended to the history log

### Admin — Timeout Configuration
- [ ] Admin can view the current `probeTimeoutMs` value
- [ ] Admin can update it within the 500–10000ms valid range
- [ ] Values outside the range show a validation error and are rejected
- [ ] Saved timeout change is appended to the history log

### General
- [ ] Logout clears the session and redirects to `/`
- [ ] `POST /api/login` is rate-limited
- [ ] All secrets are loaded from environment variables
- [ ] `GET /api/mirrors` public response excludes labels and operator metadata

---

## Out of Scope (Future Considerations)

- Server-side uptime monitoring with alerting
- Weighted or geographic mirror routing
- Email or webhook notification on mirror list changes
- Multi-operator access with role-based permissions
- Analytics (redirect counts, per-mirror success/failure rates)
- Automated mirror discovery or health-score ranking
