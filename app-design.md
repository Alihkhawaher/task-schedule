# Task Schedule — App Design Document

## Philosophy

### Core Principles

1. **Standalone** — No external service dependencies. All libraries, fonts, and icons are bundled locally. The app works without internet.

2. **Data is everything** — Multiple persistence layers protect data: in-memory cache, localStorage, and P2P sync. Every data change is written to all layers simultaneously. Data survives logout, page refresh, and browser restart.

3. **P2P is core** — Devices connect directly peer-to-peer via WebRTC. No cloud, no middleman, no data collection, no relay servers. The data flows browser-to-browser over the local network.

4. **User control** — Privacy, flexibility, and ownership in the hands of the user. No telemetry, no analytics, no tracking. The user owns their data, their devices, their network.

### What This Means in Practice

- **No servers** — Not even a local relay. Every device is both a client and a peer.
- **No external services** — No CDN, no cloud APIs, no authentication services. Everything is local.
- **No data leaves the network** — WebRTC connections stay on the LAN. No data is sent to any third party.
- **QR codes for discovery** — New devices join the mesh by scanning a QR code from an existing device. No accounts, no emails, no phone numbers.

---

## How to Best Use This App

### The Family Tablet Model

This app is designed as a **shared family device** — a tablet or computer that lives in a common area (kitchen, living room). Every family member walks up to it and checks in their tasks. There is no individual login session.

**Setup (one-time, by the admin):**
1. Create the family on the admin device (phone or PC)
2. Open Settings → مشاركة الجهاز — scan the QR from the family tablet
3. Approve the tablet — it's now connected permanently

**Daily use (everyone):**
1. Walk up to the family tablet
2. See the schedule — all members, all tasks, all days
3. Tap a cell → if the member has a PIN, enter it → check off completed tasks
4. That's it. Data syncs to all connected devices automatically.

**Why this works:**
- No passwords to remember — only the admin needs a PIN for settings
- No accounts — family members are just names in the list
- No cloud — data stays in the house
- Shared device means everyone sees the same schedule

### The Admin's Phone

The admin device (typically a phone) is the **control center**:
- Add/remove family members and tasks
- Approve new devices joining the family
- Export data for backup
- Change rewards, punishments, and settings
- All actions require PIN verification

### Data Backup Strategy

Since there's no cloud, data backup is the admin's responsibility:
- Use **تصدير البيانات** (Export Data) in Settings → regularly save a JSON backup
- Store backups on a USB drive, email, or cloud storage of your choice
- Use **استيراد البيانات** (Import Data) to restore from a backup file

### The Peer Mesh

Once multiple devices are connected, they form a **mesh network**:
- Every device syncs with every other device
- If one device goes offline, data is preserved on all other devices
- When it comes back online, it catches up automatically
- The more devices connected, the more resilient the data

---

## Architecture

### Network Model: WebRTC Mesh

```
┌──────────┐     WebRTC      ┌──────────┐
│ Device A │ ←─────────────→ │ Device B │
│ (Phone)  │                 │ (Tablet) │
└────┬─────┘                 └────┬─────┘
     │        WebRTC               │
     │                             │
┌────┴─────┐                 ┌────┴─────┐
│ Device D │ ←─────────────→ │ Device C │
│ (Laptop) │                 │ (PC)     │
└──────────┘    WebRTC       └──────────┘
```

- Every device connects to every other device (full mesh)
- WebRTC data channels carry Trystero sync messages
- All connections are LAN-local (no STUN/TURN servers needed for LAN)
- Devices auto-reconnect using saved peer info in localStorage

### Data Flow

```
User action (tap task)
    → Update in-memory cache
    → Write to localStorage (instant, persists)
    → Write to P2P (syncs to all peers via WebRTC)
    → Update UI
```

### Persistence Layers

| Layer | Storage | Survives | Speed |
|-------|---------|----------|-------|
| In-memory | JavaScript objects | Current session | Instant |
| localStorage | Browser storage | Logout, refresh, restart | Instant |
| P2P peers | Other devices' localStorage | Device offline | Network speed |

Every data change writes to all three layers simultaneously.

---

## Peer Discovery & Connection

### How Trystero Works

Uses **Trystero** library for WebRTC peer-to-peer connections via Nostr network signaling:
- Nostr relays are used **only for peer discovery** (signaling)
- Actual data flows directly between devices via **WebRTC** (encrypted)
- Both devices must be online simultaneously for initial connection
- Once connected, data syncs in real-time via `makeAction()` channels

### Onboarding a New Device

#### Step 1: Admin Opens Share Section (existing device)

1. Admin opens Settings (requires PIN verification)
2. Scrolls to "مشاركة الجهاز" (Share Device) section
3. App generates a **share link** containing `?join=FAM-XXXXXX&room=<random-room-id>`
4. App shows a **QR code** with the same URL
5. The random room ID is included in the URL (not just the family code)
6. Link can be shared via WhatsApp, SMS, AirDrop, etc.

#### Step 2: New Device Connects

1. New device opens the link or scans QR
2. Connection page extracts family code AND random room ID from URL
3. Stores room ID in localStorage
4. P2P module initializes and joins the Trystero room using the random room ID
5. Shows "جاري الاتصال بالغرفة..." (Connecting to room...)
6. When peer joins → shows device name input field

#### Step 3: New Device Sends Request

1. User enters device name (e.g., "تابلت غرفة الجلوس")
2. Clicks "إرسال طلب الانضمام" (Send Join Request)
3. Sends `join-request` message with device name and optional approval token
4. Shows "في انتظار موافقة المسؤول..." (Waiting for admin approval...)
5. Rate limited: 10-second cooldown, max 3 attempts per session

#### Step 4: Admin Approves (existing device)

1. Admin sees the request **inside the share section** in Settings — with device name
2. Clicks [قبول] (Approve) → generates approval token → sends token + family data
3. Or clicks [رفض] (Reject) → sends rejection
4. Requests are rate limited: max 5 requests per device per 5 minutes

#### Step 5: Connection Established

1. New device receives approval + data
2. Stores approval token for future reconnections
3. Saves all family data to localStorage
4. **Auto-redirects to the main schedule page** — no login required
5. Family data syncs automatically going forward

#### Reconnection (previously approved device)

1. Sends join-request with stored approval token
2. Admin device verifies token hash → auto-approves (no dialog)
3. Data flows immediately

### Device Naming

Each device can be named (e.g., "هاتف الأب", "تابلت غرفة الجلوس") via Settings → الأجهزة المتصلة:
- Name is stored in `localStorage` under `taskSchedule_deviceName`
- On peer join, the device name is sent to the new peer
- Names are displayed in the connected devices list
- Name changes are broadcast to all connected peers

### Peer List (stored in localStorage)

```json
{
  "taskSchedule_peers": {
    "peer_abc123": {
      "name": "هاتف الأب",
      "lastSeen": 1689300000
    },
    "peer_def456": {
      "name": "حاسوب سارة",
      "lastSeen": 1689299000
    }
  },
  "taskSchedule_deviceName": "هاتف الأب"
}
```

### Auto-Reconnect

On page load:
1. Load peer list from localStorage
2. For each known peer, try to establish WebRTC connection
3. If peer is online and responds → connection restored
4. If peer is offline → mark as inactive, retry periodically

### Stay Awake

The PWA periodically pings connected peers to maintain connections:
- `setInterval` every 30 seconds sends a heartbeat
- Wake Lock API (where supported) keeps the screen on
- Service Worker (future) enables background sync

---

## Security

### Three-Layer Security Model

The app implements a security model designed for a family P2P app where all approved members are trusted.

#### Layer 1: Random Room ID (Network Privacy)

When a family is created, a **cryptographically random room ID** (32 bytes, hex-encoded) is generated using `crypto.getRandomValues()`. This room ID is used as the Trystero/WebRTC room name — **not** the human-readable family code.

| What | Example | Where Stored |
|------|---------|-------------|
| Family code | `FAM-TS9GKJ` | URL params, UI |
| Room ID | `e4a8f2c91b7d603f9e5c...` | Admin's localStorage only |
| Share link | `?join=FAM-TS9GKJ&room=e4a8f2c9...` | QR code, WhatsApp |

The random room ID has zero mathematical relationship to the family code. Nostr relay operators see only a random hex string — they cannot identify which family is connecting.

#### Layer 2: Admin Approval Gate (Data Protection)

When a new device joins the Trystero room, it does **NOT** receive any family data automatically. The new device sends a `join-request` message and waits for admin approval:

1. New device opens share link → extracts family code + room ID from URL
2. Stores room ID in localStorage → joins Trystero room
3. Sends `join-request` with device name → shows "Waiting for admin approval..."
4. Admin device receives request → shows it in the share section with device name
5. Admin taps Approve → generates approval token → sends token + family data
6. New device receives data → stores approval token → auto-redirects to app

No data is transmitted until the admin explicitly approves the connection.

#### Layer 3: Approval Tokens (Persistent Trust)

Once approved, a device receives a **cryptographically random approval token** (32 bytes):

| Storage | What | Purpose |
|---------|------|---------|
| Approved device | Raw token (localStorage) | Present on next connection |
| Admin device | SHA-256 hash of token | Verify without storing raw token |

On reconnection, the approved device sends its token with the join-request. The admin device hashes the incoming token and checks it against stored hashes. If matched, the device is auto-approved without showing the dialog.

Admin can revoke any approved device from Settings → الأجهزة المتصلة. Revoked devices need re-approval on next connection.

### Security Properties Summary

| Attack Vector | Protection | Layer |
|---------------|-----------|-------|
| Relay operator sees family code | Random room ID replaces family code | Layer 1 |
| Anyone with share link gets data | Admin must approve before data is sent | Layer 2 |
| Approved device reconnects | Token-based auto-approval (no dialog) | Layer 3 |
| Stolen share link | Still needs admin approval | Layer 2 |
| Device lost/stolen | Admin revokes token | Layer 3 |
| Spam requests | Rate limiting (5 per device per 5 min) | Layer 2 |

### Rate Limiting

**New device side:**
- 10-second cooldown between join-request sends
- Maximum 3 attempts per page session
- After 3 attempts: "too many attempts, refresh to retry"

**Admin side:**
- Maximum 5 requests per device per 5-minute window
- Excess requests are auto-rejected silently
- Rate limit state resets on page refresh

### Authentication
- **PIN-based** — 4-6 digit PIN per family member (only for task check-in and admin actions)
- **SHA-256 hashing** — Browser-native Web Crypto API, no external libraries
- **Fixed salt** — All PINs hashed with the same salt (acceptable for family app where all members are trusted)

### PIN Usage Model

This app uses a **shared tablet** model. There is no login/session per person:

| Action | Requires PIN? | Notes |
|--------|--------------|-------|
| View schedule | ❌ No | Everyone sees the full schedule |
| Check in a member's tasks | ✅ Only if member has PIN | If no PIN, anyone can check in |
| Enter settings | ✅ Always | Admin PIN required |
| Settings actions (add/edit/delete) | Grace period applies | Refreshes timer |
| Export/Import data | Grace period applies | Refreshes timer |
| Reset data | ✅ Always | No grace period |

### Data Protection
- No passwords stored — only salted hashes
- No external auth services — PIN-only
- No telemetry — zero data leaves the network
- Data at rest: plain JSON in localStorage (acceptable — browser isolation, no cloud)
- Transport: WebRTC DTLS encryption between peers

---

## Data Model

### Gun.js Structure

```
families/{FAM-XXXXXX}/
    familyName: string
    adminName: string
    createdAt: timestamp

families/{FAM-XXXXXX}/members/{memberId}
    name: string
    pinHash: string
    role: "admin" | "member"
    createdAt: timestamp

families/{FAM-XXXXXX}/tasks/{taskId}
    name: string
    color: string (hex)
    createdAt: timestamp

families/{FAM-XXXXXX}/completions/{userId}_{date}_{taskId}
    userId: string
    taskId: string
    date: string (YYYY-MM-DD)
    completed: boolean
    timestamp: number

families/{FAM-XXXXXX}/settings/
    pinGracePeriod: number (minutes)
    startDate: string (YYYY-MM-DD)
```

### Rewards & Punishments Config

The admin can configure reward amounts and punishment thresholds via Settings → المكافآت والعقوبات:

```
APP_CONFIG = {
    rewards: { week: 100, month: 500 },  // ريال
    punishments: [
        { threshold: 5, description: 'منع استخدام الهاتف' },
        { threshold: 35, description: 'منع مشاهدة التلفاز' },
        { threshold: 50, description: 'منع الخروج من المنزل' }
    ]
}
```

- Stored in `localStorage` under `taskSchedule_rewardConfig_{familyCode}`
- Synced via P2P alongside user/task/completion data
- Rewards are calculated: 100% weekly completion = weekly reward, 100% monthly = monthly reward
- Punishments: if completion rate < threshold → punishment is active

### Data Export/Import

Admins can export and import all family data via Settings → إدارة البيانات:

**Export format (JSON):**
```json
{
    "version": "v6",
    "exportedAt": "2026-07-12T15:00:00.000Z",
    "familyCode": "FAM-TS9GKJ",
    "familyName": "عائلة الأحمدي",
    "deviceName": "تابلت غرفة الجلوس",
    "roomId": "e4a8f2c91b7d603f9e5c...",
    "approvalToken": "a1b2c3d4...",
    "approvedTokens": { "hash1": { "deviceName": "...", "approvedAt": ... } },
    "data": {
        "users": { ... },
        "tasks": { ... },
        "completions": { ... }
    },
    "rewardConfig": {
        "rewards": { "week": 100, "month": 500 },
        "punishments": [ ... ]
    },
    "settings": {
        "pinGracePeriod": 1,
        "startDate": "2026-01-01"
    }
}
```

- **Full backup** — includes roomId, approvedTokens, approvalToken, and deviceName
- Import restores everything: data, settings, P2P room connection, and trusted devices
- Import overwrites all current data (with confirmation dialog)
- Requires PIN verification for both export and import

### Real-time Sync

Every data mutation (add/edit/delete user, task, toggle completion, reset) calls `broadcastCurrentData()` which sends the full dataset to all connected peers via Trystero. On peer join, full data is exchanged via `sendFamilyDataToPeer()`.

Stale peers (not seen in 1 hour) are auto-purged from localStorage on page load.

### localStorage Keys

| Key | Content | Who Has It |
|-----|---------|-----------|
| `taskSchedule_{FAM-XXX}` | JSON backup of all family data (users, tasks, completions) | All devices |
| `taskSchedule_peers` | JSON map of known P2P peers with names and last seen (auto-purged > 1hr) | All devices |
| `taskSchedule_deviceName` | This device's display name | All devices |
| `taskSchedule_rewardConfig_{FAM-XXX}` | JSON rewards/punishments configuration | All devices |
| `taskSchedule_roomId_{FAM-XXX}` | Random room ID for Trystero/WebRTC room | All devices (via share link) |
| `taskSchedule_approvedTokens` | JSON map of `hash(token) → { deviceName, approvedAt, lastSeen }` | Admin device only |
| `taskSchedule_approvalToken` | Raw approval token (presented on reconnection) | Approved devices |
| `taskSchedule_lastSession` | JSON `{familyCode, memberName, familyName, timestamp}` for PWA session persistence (30-day expiry) | All devices |
| `sessionStorage: familyCode` | Current session family code | Current session |
| `sessionStorage: memberName` | Current session member name (or device name for shared tablet) | Current session |
| `sessionStorage: familyName` | Current session family name | Current session |

---

## UI Design

### Login Page (index.html)

Two sections only:

**Create Family** (default):
- Family name, admin name, PIN
- Shows family code after creation
- "Enter App" button

**Connection** (via QR/share link):
- Step 1: Connecting to room (auto)
- Step 2: Device name input (user action)
- Step 3: Waiting for approval (auto)
- Step 4: Rejected (retry option)
- On approval: auto-redirect to main app

### Schedule Page

- **Stats bar** — 4 cards: rewards, punishments, avg completion, current week
- **Quick actions** — Statistics, Rewards, Punishments buttons
- **Icon legend** — 6 SVG status levels explained
- **Task legend** — Color-coded task chips
- **Schedule table** — Date column (number + name aligned), SVG status icons per cell
- **Today highlight** — Blue tint on current day column

### Settings Overlay

Slides in from right (full-screen on mobile, 480px on desktop):
- إدارة المستخدمين (Users) — add, edit PIN, delete
- إدارة المهام (Tasks) — add, delete
- مشاركة الجهاز (Share Device) — QR code + shareable link + connection requests with approve/reject
- الأجهزة المتصلة (Connected Devices) — peer list with status, device name
- إعدادات الجدول (Schedule Settings) — grace period, start date
- المكافآت والعقوبات (Rewards & Punishments) — weekly/monthly amounts, punishment thresholds
- إدارة البيانات (Data) — export, import, reset

### Design Tokens

```css
--primary: #6366f1 (indigo)
--success: #10b981 (emerald)
--warning: #f59e0b (amber)
--danger: #ef4444 (red)
--bg: #f1f5f9 (slate-100)
--card: #ffffff
--text: #1e293b (slate-800)
--text-muted: #64748b (slate-500)
--border: #e2e8f0 (slate-200)
font-family: Tajawal (Arabic, bundled locally)
```

---

## File Structure

```
├── index.html              # Login page (Create Family + Connection)
├── manifest.json           # PWA manifest
├── README.md               # Documentation
├── app-design.md           # This file
├── .gitignore
└── app/
    ├── index.html          # Main app (schedule + settings)
    ├── app.js              # Core: schedule, P2P, PIN, stats, join requests
    ├── config.js           # Settings: users, tasks, device name, rewards, export/import
    ├── p2p.js              # Trystero/Nostr P2P: connect, approval tokens, room management
    ├── styles.css          # All styles
    └── libs/
        ├── bootstrap.min.css
        ├── bootstrap.bundle.min.js
        ├── bootstrap-icons.css
        ├── fonts/           # Bootstrap icons + Tajawal fonts
        ├── tajawal.css
        ├── jquery-3.7.0.min.js
        ├── chart.umd.min.js
        ├── moment.min.js
        ├── moment-ar.min.js
        ├── gun.js
        ├── sweetalert2.all.min.js
        ├── qrcode.min.js       # QR code generation
        └── trystero-bundle.js  # Trystero WebRTC/Nostr P2P library
```

---

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| P2P | Trystero (Nostr + WebRTC) | Direct browser-to-browser sync |
| Database | Gun.js (local only) | Local data structure |
| Auth | Web Crypto API (SHA-256) | PIN hashing |
| Charts | Chart.js | Progress visualization |
| UI | Bootstrap 5 + Tajawal font | Responsive Arabic-first design |
| QR Codes | qrcode.js | Device discovery |
| Notifications | SweetAlert2 | User alerts |
| PWA | Web App Manifest | Installable on mobile and desktop |
| Hosting | GitHub Pages | Free static hosting, no server needed |

---

## Migration from Relay-Based Architecture

The previous version used `relay.js` (a Node.js server) as a sync hub. This has been replaced with direct WebRTC P2P via Trystero:

| Before (relay) | After (Trystero P2P) |
|----------------|---------------------|
| One device runs `node relay.js` | No server needed — uses public Nostr relays for signaling only |
| Other devices connect to relay IP | Devices connect via share link / QR code |
| Single point of failure | Mesh — any device can sync with any |
| Requires Node.js | Pure browser, no dependencies |
| LAN only (requires known IP) | LAN + internet (auto-discovery via Nostr + WebRTC) |

The old `relay.js` has been removed from the codebase.