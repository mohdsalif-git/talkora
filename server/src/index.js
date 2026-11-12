import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { attachRealtime } from './socket/index.js';
import { getCounters } from './config/counters.js';
import reportRouter from './routes/report.js';
import { ICE_SERVERS, hasTurn } from './config/iceServers.js';

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim());
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/talkora';

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.use('/api', reportRouter);

app.get('/api/ice-config', (_req, res) => {
  res.json({
    iceServers: ICE_SERVERS,
    hasTurn,
    note: 'TURN credentials omitted from response; client fetches per-call if needed.',
  });
});

app.get('/api/stats', async (_req, res) => {
  let counters = { totalVisits: 0, totalConnections: 0 };
  try {
    counters = await getCounters();
  } catch {
    /* MongoDB unavailable — serve zeros */
  }
  res.json({
    ...counters,
    ...engine.getLiveStats(),
    mongoConnected: mongoose.connection.readyState === 1,
  });
});

const httpServer = http.createServer(app);
const { engine } = attachRealtime(httpServer, CLIENT_ORIGINS);

// MongoDB is optional infrastructure: realtime chat works without it,
// the aggregate counters simply stay at zero.
mongoose.set('strictQuery', true);
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log(`[mongo] connected → ${MONGODB_URI}`))
  .catch((err) => console.warn(`[mongo] unavailable — counters disabled (${err.message})`));

httpServer.listen(PORT, () => {
  console.log(`[talkora-server] listening on http://localhost:${PORT}`);
  console.log(`[talkora-server] CORS origins: ${CLIENT_ORIGINS.join(', ')}`);
});

async function shutdown(signal) {
  console.log(`\n[talkora-server] ${signal} received — shutting down`);
  engine.destroy();
  await Promise.allSettled([mongoose.disconnect(), new Promise((r) => httpServer.close(r))]);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
