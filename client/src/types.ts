export type Gender = 'male' | 'female';
export type Mode = 'text' | 'audio';
export type Screen = 'home' | 'gender' | 'mode' | 'matching' | 'chat';

export interface ChatMessage {
  id: string;
  text: string;
  at: number;
  mine: boolean;
}

export interface LiveStats {
  online: number;
  waiting: number;
  activeMatches: number;
  totalVisits: number;
  totalConnections: number;
}

export interface ServerToClientEvents {
  'session:queued': (payload: { gender: Gender; mode: Mode }) => void;
  'match:found': (payload: { matchId: string; mode: Mode }) => void;
  'match:ended': (payload: { reason: string }) => void;
  'match:cancelled': () => void;
  'chat:message': (payload: { text: string; at: number }) => void;
  'chat:typing': (payload: { typing: boolean }) => void;
  'stats:live': (payload: LiveStats) => void;
  'system:error': (payload: { message: string }) => void;
  // WebRTC signaling
  'call:offer': (payload: { from: string; sdp: string; matchId: string }) => void;
  'call:answer': (payload: { from: string; sdp: string; matchId: string }) => void;
  'call:ice-candidate': (payload: { from: string; candidate: RTCIceCandidateInit | null; matchId: string }) => void;
  'call:ended': (payload: { reason: string; matchId: string }) => void;
  // Report / block
  'report:sent': (payload: { id: number; reason: string }) => void;
  'block:set': () => void;
}

export interface ClientToServerEvents {
  'session:join': (payload: { gender: Gender; mode: Mode }) => void;
  'match:cancel': () => void;
  'match:next': () => void;
  'match:leave': () => void;
  'chat:message': (payload: { text: string }) => void;
  'chat:typing': (payload: { typing: boolean }) => void;
  // WebRTC signaling
  'call:offer': (payload: { matchId: string; sdp: string }) => void;
  'call:answer': (payload: { matchId: string; sdp: string }) => void;
  'call:ice-candidate': (payload: { matchId: string; candidate: RTCIceCandidateInit | null }) => void;
  'call:active': (payload: { matchId: string }) => void;
  'call:end': (payload: { matchId: string }) => void;
  // Report / block
  'report': (payload: { reason: string }) => void;
  'block': () => void;
}
