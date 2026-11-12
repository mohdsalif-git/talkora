import express from 'express';
import { reportStore } from '../config/reportStore.js';

const router = express.Router();

/** Ephemeral report statistics — metadata only, no user data. */
router.get('/reports/stats', (_req, res) => {
  res.json(reportStore.getStats());
});

export default router;
