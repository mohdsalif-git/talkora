import mongoose from 'mongoose';

/**
 * Aggregate-only counters. Talkora deliberately persists NO individual users
 * and NO conversations — just two anonymous, aggregate totals:
 *   totalVisits       — every realtime client connection
 *   totalConnections  — every successful 1-on-1 match
 */
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Number, default: 0 },
  },
  { versionKey: false },
);

const Counter = mongoose.model('Counter', counterSchema);

export const COUNTER_KEYS = ['totalVisits', 'totalConnections'];

/** Atomic $inc on the counters collection (upsert). */
export async function incrementCounter(key) {
  if (!COUNTER_KEYS.includes(key)) throw new Error(`Unknown counter: ${key}`);
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return doc?.value ?? 0;
}

/** Read counters through an aggregation pipeline (single round-trip, summed). */
export async function getCounters() {
  const rows = await Counter.aggregate([
    { $match: { key: { $in: COUNTER_KEYS } } },
    { $group: { _id: '$key', value: { $first: '$value' } } },
  ]);
  const out = { totalVisits: 0, totalConnections: 0 };
  for (const row of rows) out[row._id] = row.value;
  return out;
}
