# Talkora

Random 1-on-1 conversations with strangers — text or audio mode, opposite-gender matching, no accounts, nothing persisted.

- **Frontend:** React 18 + Vite + TypeScript (premium minimal dark UI, violet accents)
- **Backend:** Node.js + Express + Socket.IO
- **Persistence:** two aggregate MongoDB counters only (`totalVisits`, `totalConnections`) — no users, no conversations

## Structure

```
talkora/
├── package.json            # npm workspaces root (client + server), `npm run dev` runs both
├── server/
│   ├── src/
│   │   ├── index.js                 # Express app, /api/stats, Mongo (optional), graceful shutdown
│   │   ├── socket/
│   │   │   ├── index.js             # Socket.IO bootstrap, event wiring, visit counter
│   │   │   └── matchmaking.js       # queues, atomic matching, sweeps, live stats
│   │   └── config/counters.js       # MongoDB aggregate counters ($inc writes, $group read)
│   └── .env.example
└── client/
    └── src/
        ├── App.tsx                  # screen router + toasts
        ├── global.css               # dark UI design system
        ├── hooks/useTalkora.ts      # client state machine (screens, messages, stats)
        ├── lib/socket.ts            # socket.io-client singleton
        └── components/              # Home, GenderSelect, ModeSelect, Matching, ChatRoom
```

## Setup

Requires Node 18+ (Node 20/22 recommended). MongoDB is **optional** — realtime matching works without it; the two counters just stay at zero.

```bash
# 1. Install everything (workspaces: root, client, server)
npm install

# 2. (optional) Configure the server
copy server\.env.example server\.env   # Windows
# cp server/.env.example server/.env   # macOS / Linux
#   PORT=4000
#   CLIENT_ORIGIN=http://localhost:5173
#   MONGODB_URI=mongodb://127.0.0.1:27017/talkora

# 3. Start both dev servers (concurrently)
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:4000 (`/api/health`, `/api/stats`)
- The client connects to `http://localhost:4000` by default; override with `VITE_SERVER_URL` in `client/.env`.

To point the counters at MongoDB Atlas or another instance, just change `MONGODB_URI`.

## Production build (frontend)

```bash
npm run build          # tsc + vite build → client/dist
npm run preview -w client
```

## How matching works (Phase 2)

- Four **temporary in-memory queues**: `{male, female} × {text, audio}`.
- Pairing happens **atomically** inside one event-loop turn (no two joins can race for the same partner); only **opposite genders with the same mode** are matched.
- **Duplicate-match prevention:** a session that is already `matched` ignores any `session:join`.
- **Cancellation** (`match:cancel`), **Next** (`match:next` — both sides requeue), **Leave** (`match:leave` — partner requeues, leaver goes idle).
- **Disconnects:** queue entry removed; partner is notified (`match:ended`) and automatically requeued.
- **Pair cooldown:** after Next/leave, the same two users are not instantly re-paired for 30s — "Next" always means *someone new* when one is available.
- **Stale socket cleanup:** a 10s sweep drops queue entries with dead sockets and tears down zombie matches; requeued survivors may be instantly re-matched.
- **Live stats** (`stats:live` on every change): online users, people waiting, active matches — plus the two Mongo counters.
- The only MongoDB writes are atomic `$inc` updates to `totalVisits` (per client connection) and `totalConnections` (per successful match). No individual users or conversations are ever persisted.

## Testing with multiple sessions

Open several browser tabs/windows (or profiles) at http://localhost:5173 — each tab is an independent socket:

1. Tab A: Start → Male → Text → searching.
2. Tab B: Start → Female → Text → instantly matched with A.
3. Exchange messages, try typing indicators, then **Next** on one tab — both return to searching.
4. Close one tab mid-chat — the other gets "partner left" and requeues automatically.
5. Watch the home-page stats (online / waiting / connections made / visits) and `curl http://localhost:4000/api/stats`.

Same-gender joins (male↔male) will wait in their queues and never match — that's expected.

## Phases

- ✅ **Phase 1** — frontend + backend scaffolding, responsive dark UI: homepage, gender select, mode select, matching screen, text chat layout, audio call layout (no fake functionality, no video).
- ✅ **Phase 2** — Socket.IO connection manager, matchmaking engine, atomic matching, queue/cleanup/next/disconnect handling, duplicate-match prevention, live stats, aggregate counters.
- ⏳ **Later** — real voice streaming (WebRTC), WebRTC signaling, moderation.
