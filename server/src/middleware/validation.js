/**
 * Input validation helpers for Socket.IO payloads.
 *
 * All validation is strict: unknown properties, wrong types, or oversized
 * strings cause the event to be ignored with a system:error reply.
 */
export const MAX_TEXT_LENGTH = 1000;
export const MAX_REPORT_REASON_LENGTH = 500;

export function validateGenderMode(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid payload.' };
  const { gender, mode } = payload;
  if (typeof gender !== 'string' || !['male', 'female'].includes(gender))
    return { ok: false, error: 'Invalid gender.' };
  if (typeof mode !== 'string' || !['text', 'audio'].includes(mode))
    return { ok: false, error: 'Invalid mode.' };
  return { ok: true, value: { gender, mode } };
}

export function validateChatText(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid payload.' };
  const { text } = payload;
  if (typeof text !== 'string') return { ok: false, error: 'Message must be a string.' };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Empty message.' };
  if (trimmed.length > MAX_TEXT_LENGTH) return { ok: false, error: 'Message too long.' };
  return { ok: true, value: { text: trimmed } };
}

export function validateTyping(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid payload.' };
  return { ok: true, value: { typing: Boolean(payload.typing) } };
}

export function validateReport(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Invalid payload.' };
  const { reason } = payload;
  if (typeof reason !== 'string' || !reason.trim()) {
    return { ok: false, error: 'Report reason required.' };
  }
  if (reason.trim().length > MAX_REPORT_REASON_LENGTH) {
    return { ok: false, error: 'Report reason too long.' };
  }
  return { ok: true, value: { reason: reason.trim() } };
}

/** Basic SDP sanity: must be a non-empty string starting with v=. */
export function validateSdp(sdp) {
  return typeof sdp === 'string' && sdp.length > 0 && sdp.startsWith('v=');
}

/** ICE candidate: must be an object or null (end-of-candidates). */
export function validateIceCandidate(candidate) {
  return candidate === null || (typeof candidate === 'object' && candidate !== null);
}
