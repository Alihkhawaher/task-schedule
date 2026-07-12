# 📅 Task Schedule — العائلة

> A family task schedule that syncs peer-to-peer between your devices — no servers, no cloud, no third-party services.

🔗 **App**: [https://alihkhawaher.github.io/task-schedule/](https://alihkhawaher.github.io/task-schedule/)

📦 **Source Code**: [https://github.com/Alihkhawaher/task-schedule](https://github.com/Alihkhawaher/task-schedule)

### How it works
- Devices connect directly via WebRTC (Trystero + Nostr for signaling)
- All data stored in browser localStorage — you own everything
- Sync happens between your devices only — nothing leaves your network
- No CDN, no external dependencies — everything bundled locally, works fully offline
- Installable PWA — works on phones, tablets, and desktops
- Runs from GitHub Pages — no server, no build step, no deployment needed

### Privacy
Zero telemetry. Zero analytics. Zero tracking. Your data never leaves your devices.

## Core Philosophy

1. **Standalone** — No external service dependencies. All libraries bundled locally. Works offline.
2. **Data is everything** — Multiple persistence layers (memory, localStorage, P2P sync). Data survives everything.
3. **P2P is core** — Devices connect directly via WebRTC (Trystero). No cloud, no servers, no middleman.
4. **User control** — No telemetry, no tracking. You own your data, your devices, your network.

## How P2P Works

Uses **Trystero** library for WebRTC peer-to-peer connections via Nostr network signaling:
- Nostr relays are used **only for peer discovery** (signaling)
- Actual data flows directly between devices via **WebRTC** (encrypted)
- Both devices must be online simultaneously for connection
- Once connected, data syncs in real-time

### Connecting a new device:
1. **Existing device** → click "مشاركة الجهاز" (Share Device) → copy link or show QR
2. **New device** → open link → auto-fills family code
3. New device logs in → admin approves → P2P connects
4. Family data syncs automatically

### Requirements:
- Both devices on the **same WiFi** (or internet for cross-network)
- Both devices must have the app **open** at the same time for initial connection

## Features

- 📅 Monthly schedule with SVG status icons and color-coded completion
- 👨‍👩‍👧‍👦 Multi-family support — each family has isolated data
- 🔄 P2P mesh sync via Trystero/WebRTC — no server needed
- 🔐 PIN-based check-in with configurable grace period
- 📊 Start date — schedule begins from your chosen date
- 🏆 Rewards & punishments — admin-configurable amounts and thresholds, auto-calculated
- 📊 Statistics & charts — progress visualization
- 🔑 Recovery codes — password recovery without email
- 💾 localStorage backup — data persists locally
- 📷 QR code + share link device discovery
- 📱 Device naming — name each device (e.g., "هاتف الأب") visible to other peers
- 🌐 Runs on GitHub Pages — no server or deployment needed, just open the link
- 📦 Complete package — no CDN, all libraries, fonts, and icons bundled locally

## Quick Start

### 1. Open the app
Open [https://alihkhawaher.github.io/task-schedule/](https://alihkhawaher.github.io/task-schedule/) in your browser.

### 2. Create your family
Enter family name + your name + PIN → get family code + recovery code.

### 3. Share with family
Click "مشاركة الجهاز" → share the link or QR code with family members.

### 4. Family members join
Open shared link → family code auto-fills → enter name + PIN → admin approves → start using.

## Data Protection

| Layer | What | Survives |
|-------|------|----------|
| In-memory | JS objects | Current session |
| localStorage | Browser storage | Logout, refresh, restart |
| P2P peers | Other devices' storage | Device offline |

## PIN Security

| Action | Always asks? | Grace period |
|--------|-------------|-------------|
| Enter settings | ✅ Yes | No |
| Settings actions | No | Yes (refreshes) |
| Data reset | ✅ Yes | No |
| Task cell click | No | Yes (refreshes) |

## File Structure

```
├── index.html              # Login page
├── manifest.json           # PWA manifest
├── README.md               # This file
├── app-design.md           # Comprehensive design document
├── testing/                # Test scripts
│   ├── run_tests.py        # Static file/code validation
│   └── p2p_test.py         # Live P2P connectivity tests
└── app/
    ├── index.html          # Main app (schedule + settings overlay)
    ├── app.js              # Core logic (schedule, stats, rewards, P2P broadcast)
    ├── config.js           # Settings logic (users, tasks, PIN, device name, rewards)
    ├── p2p.js              # Trystero/WebRTC P2P module
    ├── styles.css          # Styles (responsive, RTL support)
    ├── icons/              # SVG icons for PWA manifest
    └── libs/               # All dependencies (bundled locally)
```

## Testing

```bash
# Static validation — file structure, code patterns
python testing/run_tests.py

# Live P2P tests — Nostr relay connectivity, WebSocket, event exchange
python testing/p2p_test.py
```

Tests verify:
- All Trystero API methods present and correct
- Defensive `peerId` extraction in all message handlers
- Nostr relay connectivity (HTTPS + WebSocket)
- Share link format correct

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| P2P | Trystero (Nostr + WebRTC) | Direct browser-to-browser sync |
| Database | Gun.js (local only) | Local data structure |
| Auth | Web Crypto API (SHA-256) | PIN hashing |
| Charts | Chart.js | Progress visualization |
| UI | Bootstrap 5 + Tajawal | Arabic-first responsive design |
| QR | qrcode-generator | Device discovery |
| PWA | Web App Manifest + Service Worker | Installable on mobile and desktop |
| Hosting | GitHub Pages | Free static hosting, no server needed |

## Security Model

The app implements a **three-layer security model** designed for a family P2P app where all approved members are trusted.

### Layer 1: Random Room ID (Network Privacy)

When a family is created, a **cryptographically random room ID** (32 bytes, hex-encoded) is generated using `crypto.getRandomValues()`. This room ID is used as the Trystero/WebRTC room name — **not** the human-readable family code. Nostr relay operators see only a random hex string.

### Layer 2: Admin Approval Gate (Data Protection)

When a new device joins the Trystero room, it does **NOT** receive any family data automatically. Instead:

```
New Device                          Admin Device
    │                                    │
    ├── Joins room (via room ID) ────────┤
    ├── Sends "join-request" ───────────→│
    │                                    ├── Shows approval dialog
    │                                    ├── Admin taps [Approve] or [Reject]
    │←── Receives approval + data ────────┤
    ├── Shows login form                 │
```

- **No data is sent until admin explicitly approves** the new device
- The approval dialog shows the requesting device's name
- Admin can reject unknown devices

### Layer 3: Approval Tokens (Persistent Trust)

Once approved, a device receives a **cryptographically random approval token** (32 bytes). This token enables seamless reconnection without re-approval:

| Storage | What | Purpose |
|---------|------|---------|
| Approved device | Raw token (localStorage) | Present on next connection |
| Admin device | SHA-256 hash of token | Verify without storing raw token |

**Reconnection flow**:
1. Previously approved device joins room → sends `join-request` with stored token
2. Admin device receives → computes SHA-256 of incoming token → checks against stored hashes
3. Match found → **auto-approves** (no dialog) → sends family data
4. No match → shows approval dialog (new/unknown device)

**Revocation**: Admin can remove any approved device from Settings → Connected Devices. The device will need re-approval on next connection.

### Security Properties Summary

| Attack Vector | Protection | Layer |
|---------------|-----------|-------|
| Relay operator sees family code | Random room ID replaces family code | Layer 1 |
| Anyone with share link gets data | Admin must approve before data is sent | Layer 2 |
| Approved device reconnects | Token-based auto-approval (no dialog) | Layer 3 |
| Stolen share link | Still needs admin approval | Layer 2 |
| Device lost/stolen | Admin revokes token | Layer 3 |

### PIN Security

PINs are used for **UI-level identity verification** within the app (not as a cryptographic gate):

- SHA-256 hash with fixed salt (`task-schedule-salt`)
- 4-6 digit numeric PINs
- Grace period: after entering PIN, won't be asked again for configurable duration
- Settings entry: always requires PIN (no grace period)
- Data reset: always requires PIN (no grace period)

### Data-at-Rest

Data is stored in **plain JSON** in localStorage. This is acceptable for a family app because:
- Each family member has physical access to their own device
- Browser isolation prevents cross-origin access
- No cloud backup means no server-side data breach risk

### Transport Security

- **WebRTC DTLS**: All peer-to-peer data is encrypted in transit by WebRTC
- **Nostr relays**: Used only for signaling (peer discovery), not data transfer
- **No CDN, no server**: All dependencies bundled locally, zero external calls

## Known Limitations

- Both devices must be online simultaneously for initial P2P connection
- Nostr relay servers used for signaling only (some may be temporarily down)
- Data is device-local — no cloud backup
- If localStorage is cleared, device needs a new share link to rejoin
- PWA background sync limited by browser policies

## License

MIT