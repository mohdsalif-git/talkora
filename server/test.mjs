// Quick integration test — spins up the full server in-process and hits every endpoint.
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import reportRouter from './src/routes/report.js';
import { ICE_SERVERS, hasTurn } from './src/config/iceServers.js';
import { attachRealtime } from './src/socket/index.js';

process.env.PORT = '4099';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

const CLIENT_ORIGINS = ['http://localhost:5173'];

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.use('/api', reportRouter);
app.get('/api/ice-config', (_req, res) => res.json({ iceServers: ICE_SERVERS, hasTurn }));
app.get('/api/stats', (_req, res) => {
  res.json({ ...engine.getLiveStats(), mongoConnected: false, totalVisits: 0, totalConnections: 0 });
});

const httpServer = http.createServer(app);
const { engine } = attachRealtime(httpServer, CLIENT_ORIGINS);

let passed = 0;
let failed = 0;

function assert(label, cond, got) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} — got: ${JSON.stringify(got)}`);
    failed++;
  }
}

httpServer.listen(4099, async () => {
  console.log('\n── Talkora Backend Integration Test ──\n');
  const base = 'http://localhost:4099';

  try {
    // 1. Health
    console.log('GET /api/health');
    const h = await fetch(base + '/api/health').then(r => r.json());
    assert('ok === true', h.ok === true, h);
    assert('uptime is number', typeof h.uptime === 'number', h);

    // 2. ICE config
    console.log('\nGET /api/ice-config');
    const ice = await fetch(base + '/api/ice-config').then(r => r.json());
    assert('iceServers is array', Array.isArray(ice.iceServers), ice);
    assert('has at least one STUN', ice.iceServers.length >= 1, ice);
    assert('hasTurn is boolean', typeof ice.hasTurn === 'boolean', ice);
    assert('STUN URL present', ice.iceServers[0].urls.includes('stun:'), ice.iceServers[0]);

    // 3. Stats
    console.log('\nGET /api/stats');
    const s = await fetch(base + '/api/stats').then(r => r.json());
    assert('online is number', typeof s.online === 'number', s);
    assert('waiting is number', typeof s.waiting === 'number', s);
    assert('activeMatches is number', typeof s.activeMatches === 'number', s);
    assert('mongoConnected present', 'mongoConnected' in s, s);

    // 4. Report stats
    console.log('\nGET /api/reports/stats');
    const rs = await fetch(base + '/api/reports/stats').then(r => r.json());
    assert('totalReports is number', typeof rs.totalReports === 'number', rs);
    assert('reasonCounts is object', typeof rs.reasonCounts === 'object', rs);
    assert('recent is array', Array.isArray(rs.recent), rs);

    // 5. CORS header
    console.log('\nCORS check');
    const corsRes = await fetch(base + '/api/health', { headers: { Origin: 'http://localhost:5173' } });
    const corsHeader = corsRes.headers.get('access-control-allow-origin');
    assert('CORS origin header present', corsHeader !== null, corsHeader);

    // 6. Unknown route → 404
    console.log('\nGET /api/doesnotexist');
    const r404 = await fetch(base + '/api/doesnotexist');
    assert('404 for unknown route', r404.status === 404, r404.status);

    // 7. POST with bad body → validation
    console.log('\nSocket.IO module loaded');
    assert('engine.getLiveStats() works', typeof engine.getLiveStats().online === 'number', null);
    assert('engine.sessions is Map', engine.sessions instanceof Map, null);
    assert('engine.matches is Map', engine.matches instanceof Map, null);
    assert('engine.queues has 4 keys', Object.keys(engine.queues).length === 4, null);

  } catch (err) {
    console.error('Test threw:', err);
    failed++;
  }

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  engine.destroy();
  httpServer.close(() => process.exit(failed > 0 ? 1 : 0));
});

