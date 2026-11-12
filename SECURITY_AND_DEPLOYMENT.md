# Talkora — Security, Privacy & Deployment Audit (Phase 4)

This document covers the security and privacy review of Talkora, deployment instructions
for free-tier hosting, and WebRTC TURN bandwidth/hosting limitations.

## 1. Data model — what is (and isn't) stored

Talkora persists **nothing** about individual users or conversations.

| Collection / Store | Contents | Persistence |
|---|---|---|
| `counters` (MongoDB) | `totalVisits`, `totalConnections` — atomic `$inc` only | Yes (aggregate only) |
| `reportStore` (memory) | Last 1000 reports: shortened socket ids, reason category, mode, timestamp | Process lifetime only |
| `blocks` (memory) | socketId → Set of blocked socketIds | Process lifetime only |
| `sessions` / `matches` / `queues` (memory) | socketId → gender/mode/state; match pairings | Process lifetime only |

**Never stored:** message text, audio, IP addresses, user agents, cookies, tokens,
names, photos, or any identifier that outlives the socket connection.

### Verification query

Connect to MongoDB and confirm only aggregate counters exist:

```js
db.getCollectionNames()          // → [ "counters" ]
db.counters.find()               // → { key: "totalVisits", value: N } / { key: "totalConnections", value: N }
```

No `users`, `messages`, `conversations`, or `reports` collections exist.

## 2. Socket.IO room authorization

- When a match is created, both sockets join a match-scoped room: `match_<matchId>`.
- All signaling events (`call:offer`, `call:answer`, `call:ice-candidate`, `call:active`, `call:end`)
  are authorized: the server verifies the sender is a participant of that match via
  `calls.isAuthorized(socket.id, matchId)` before relaying.
- Chat events (`chat:message`, `chat:typing`) are relayed only to the current partner
  via `engine.partnerOf(socket.id)`, which requires an active matched state.
- There is no global broadcast of user data; `stats:live` publishes only aggregate counts.

## 3. Rate limiting & spam / abuse

Per-socket token-bucket rate limiters (in-memory, reset every 60s):

| Event | Limit | Window |
|---|---|---|
| `call:offer` / `call:answer` / `call:ice-candidate` | 30 / min | signaling |
| `chat:message` | 20 / min | chat |
| `report` | 5 / min | reports |

Rate-limited events receive `system:error` ("Too many requests. Slow down.") and are
not relayed. Because Talkora is 1-on-1 and ephemeral, there is no room-spam or
broadcast-amplification vector.

## 4. Report / block functionality (session-level)

- **Report:** While matched, either user can send `report { reason }`. The server
  records metadata only (shortened socket ids, reason category, mode, timestamp) in
  a bounded in-memory ring buffer (max 1000 entries). The reporter gets `report:sent`
  confirmation. The reported user is **not** notified.
- **Block:** `block` adds the current partner to the requester's session-level block
  set. Matchmaking (`firstValidExcept`) skips any pair where either side has blocked
  the other, for the rest of that session. Blocks are ephemeral — cleared on
  disconnect and never shared between users.
- Report stats endpoint: `GET /api/reports/stats` returns aggregate counts only
  (total + per-reason breakdown, last 10 entries with shortened ids).

## 5. 18+ access policy

Talkora pairs strangers for live conversation and is intended for adults (18+).

- The homepage displays a clear age notice before "Start a conversation":
  > Talkora is for adults 18+. By continuing you confirm you are 18 years or older.
- There is no account system, so age cannot be verified technically. The policy is
  a contractual notice; operators should add a gate if deploying to a general audience.
- No content is stored, so there is no historical moderation queue. Real-time
  report/block is the primary abuse-response mechanism.

## 6. Privacy disclosures

Displayed on the homepage and before microphone access:

- **No accounts.** We never ask for your name, email, phone, or photo.
- **Nothing is saved.** Messages and audio are not written to disk or a database.
- **Ephemeral by design.** When you close the tab or leave, your match data is gone.
- **Microphone.** Audio only. We never request camera access and never record audio.
  Browser permission is requested explicitly (user gesture) before any microphone
  use; you can mute at any time.
- **Aggregate stats only.** `totalVisits` and `totalConnections` are anonymous counters.

## 7. Logging review

Server logs are metadata-only:

- Socket connect/disconnect: socket id prefix (first 6 chars) + event name.
- Match events: match id + mode + gender pair (no PII).
- Signaling: `matchId`, direction (offer/answer/ice), never SDP contents.
- Reports: reason category, mode, shortened ids.
- Errors: event name + error category (never payload content).

**Message text, audio, SDP payloads, and ICE candidates are never logged.**

## 8. Dependency & supply-chain notes

- Root `postinstall` patches Rollup's native binding to fall back to `@rollup/wasm-node`
  because some Windows machines block the unsigned `.node` binary under App Control.
  This is a build-time workaround, not a runtime dependency change.
- All runtime dependencies are pinned (exact versions in `package.json`).
- `npm audit` should be run before any deployment.

## 9. Deployment — free-tier hosting

### Frontend (static)

Build once, host anywhere static:

```bash
cd client && npm run build   # → client/dist
# Deploy client/dist to Vercel, Netlify, GitHub Pages, Cloudflare Pages, etc.
```

Set `VITE_SERVER_URL` to your backend origin at build time.

### Backend (Node + Socket.IO)

Needs a long-running process with WebSocket support:

| Platform | Fit | Notes |
|---|---|---|
| **Render** (free web service) | Good | WebSockets supported; free tier sleeps after inactivity |
| **Railway** | Good | Node + Mongo add-on; small free credit tier |
| **Fly.io** | Good | Small VM free allowance |
| **Koyeb** | Good | Free tier with WebSocket support |
| **Heroku** | No longer free | Not recommended |

MongoDB (for counters only — optional):

- **MongoDB Atlas** free shared cluster (M0) — works for the two aggregate counters.
- If MongoDB is unavailable, the app degrades gracefully: counters stay at zero,
  realtime matching continues.

Required environment variables:

```
PORT=4000
CLIENT_ORIGIN=https://your-frontend.example.com
MONGODB_URI=mongodb+srv://...   # optional; counters disabled if omitted
TURN_URLS=turn:your-turn-server:3478   # optional
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

### Health checks

- `GET /api/health` → `{ ok: true, uptime }`
- `GET /api/stats` → aggregate counters + live online/waiting/match counts + mongo status
- `GET /api/ice-config` → STUN/TURN server list (credentials never exposed here)
- `GET /api/reports/stats` → ephemeral report aggregates

## 10. WebRTC TURN — bandwidth & hosting limitations

Talkora uses **peer-to-peer WebRTC audio** once signaling completes. Media does **not**
flow through the Talkora server.

### When TURN is needed

- Clients behind symmetric NATs or strict corporate firewalls cannot reach each
  directly. A TURN relay is required for those pairs.
- Without TURN, those pairs fall back gracefully: signaling still works, text chat
  works, but audio may fail to connect ("Establishing audio…" indefinitely → text).

### Bandwidth implications

- Audio Opus at ~12–64 kbps per direction per call.
- If TURN relays the media, **all audio bytes pass through your TURN server**.
- Estimate: 1 concurrent audio call ≈ 25–120 kbps sustained on the TURN server.
- Free-tier hosts usually egress-limit bandwidth (e.g., 100 GB/month). A TURN-heavy
  app can exhaust this quickly.

### Recommendations

1. **Default to STUN only** (included by default). Most consumer NATs are cone-type
   and work without TURN.
2. **Add TURN only if needed**, sourced from a dedicated TURN provider (e.g., Twilio,
   Xirsys, or self-hosted `coturn` on a cheap VPS).
3. Never turn TURN on for video — Talkora does not implement video.
4. Consider disabling audio matches entirely (text-only mode) if you cannot afford
   TURN egress on a free tier.

## 11. Critical issues resolved (Phase 4 fixes)

| Issue | Fix |
|---|---|
| Rollup native `.node` blocked on Windows | `scripts/patch-rollup-wasm.js` falls back to `@rollup/wasm-node` |
| Phantom re-pair after Next | 30s pair cooldown + block-aware matching |
| Signaling spoofing | Match-scoped Socket.IO rooms + `isAuthorized` checks |
| Mic access without consent | Explicit `enableMicrophone()` user gesture; `getUserMedia` only on click |
| Rate-limit abuse | Per-socket token buckets for chat/signaling/reports |
| Report data persistence | Bounded in-memory ring buffer; no DB writes |
| Audio resource leaks | `dispose()` closes PC, stops tracks, detaches element on leave/next/disconnect |
| Same-gender matching | Engine only pairs opposite genders |
| Duplicate concurrent match | Atomic single-event-loop-turn pairing; `state === 'matched` guard |

## 12. Remaining operator responsibilities

- Add a consent/age gate if exposing to a general audience.
- Rotate TURN credentials regularly if used.
- Monitor `/api/reports/stats` for abuse patterns (no PII retained).
- Run `npm audit` and keep dependencies updated before production deploys.
- Set `CLIENT_ORIGIN` to your exact frontend origin (no wildcard `*` in production).
