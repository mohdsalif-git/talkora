/**
 * CallManager
 * -----------
 * Manages the WebRTC audio call lifecycle per match. It does not touch the
 * media stream itself (that lives in the browser); it only tracks call state
 * and ensures signaling is authorized between the two matched sockets.
 *
 * Call states: 'idle' | 'offering' | 'answering' | 'active' | 'ended'
 */
export class CallManager {
  constructor(io) {
    this.io = io;
    this.calls = new Map(); // matchId -> { matchId, users: [idA, idB], state, offererId, startedAt }
    this.userCall = new Map(); // socketId -> matchId
  }

  /** Returns the call record for a match, or null. */
  get(matchId) {
    return this.calls.get(matchId) ?? null;
  }

  /** Returns the matchId a socket is currently in a call for, or null. */
  callFor(socketId) {
    return this.userCall.get(socketId) ?? null;
  }

  /** Authorize that socketId is a participant of matchId. */
  isAuthorized(socketId, matchId) {
    const call = this.calls.get(matchId);
    return Boolean(call && call.users.includes(socketId));
  }

  /** Create a call record when an audio match is found. */
  startCall(matchId, users, offererId) {
    if (this.calls.has(matchId)) return this.calls.get(matchId);
    const call = {
      matchId,
      users,
      state: 'offering',
      offererId,
      startedAt: Date.now(),
    };
    this.calls.set(matchId, call);
    for (const id of users) this.userCall.set(id, matchId);
    return call;
  }

  /** Transition to answering once the remote SDP answer is received. */
  setAnswered(matchId) {
    const call = this.calls.get(matchId);
    if (call) call.state = 'answering';
  }

  /** Transition to active once ICE connectivity is established (reported by client). */
  setActive(matchId) {
    const call = this.calls.get(matchId);
    if (call) call.state = 'active';
  }

  /** Tear down call tracking for a match. Returns the match's user ids. */
  endCall(matchId) {
    const call = this.calls.get(matchId);
    if (!call) return null;
    this.calls.delete(matchId);
    for (const id of call.users) this.userCall.delete(id);
    return call.users;
  }

  /** End all calls involving a socket (used on disconnect / leave / next). */
  endCallsFor(socketId) {
    const matchId = this.userCall.get(socketId);
    if (!matchId) return null;
    return this.endCall(matchId);
  }

  getActiveCallCount() {
    return this.calls.size;
  }
}
