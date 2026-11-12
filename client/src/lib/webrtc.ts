/**
 * WebRTC audio manager for Talkora.
 *
 * Handles microphone access (explicit user consent), RTCPeerConnection
 * lifecycle, and SDP/ICE signaling over Socket.IO. Audio-only — camera is
 * never requested, video is never negotiated, and nothing is recorded.
 */
export class WebRtcAudio {
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private onStateChange: (state: CallState) => void;
  private onRemoteStream: (stream: MediaStream) => void;
  private iceCandidates: RTCIceCandidate[] = [];
  private remoteCandidates: RTCIceCandidate[] = [];
  private matchId: string | null = null;
  private iceServers: RTCIceServer[];
  /** Optional callback: fired when ICE gathering is complete so callers can flush immediately. */
  onIceGatheringComplete?: () => void;

  constructor(opts: {
    iceServers?: RTCIceServer[];
    onStateChange: (state: CallState) => void;
    onRemoteStream: (stream: MediaStream) => void;
  }) {
    this.onStateChange = opts.onStateChange;
    this.onRemoteStream = opts.onRemoteStream;
    this.iceServers = opts.iceServers ?? DEFAULT_ICE_SERVERS;
  }

  /** Returns the match id this call instance is bound to (client-side only). */
  get boundMatchId(): string | null {
    return this.matchId;
  }

  set boundMatchId(value: string | null) {
    this.matchId = value;
  }

  get isAudioEnabled(): boolean {
    return this.localStream
      ? this.localStream.getAudioTracks().every((t) => t.enabled)
      : false;
  }

  get isConnected(): boolean {
    return this.pc ? this.pc.connectionState === 'connected' : false;
  }

  get isEstablishing(): boolean {
    return Boolean(this.pc) && !this.isConnected;
  }

  /** Ask the browser for microphone access. Must be triggered by a user gesture. */
  async requestMicrophone(): Promise<boolean> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('WebRTC not supported in this browser.');
    }
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Attach local audio to a muted element so we can monitor our own level.
      this.audioElement = new Audio();
      this.audioElement.srcObject = this.localStream;
      this.audioElement.muted = true;
      this.audioElement.play().catch(() => {});
      return true;
    } catch (err) {
      this.localStream = null;
      throw err;
    }
  }

  /** Create the peer connection and prepare the local offer. Requires mic access first. */
  async prepareOffer(): Promise<string> {
    if (!this.localStream) throw new Error('Microphone not yet authorized.');
    this.pc = this.createPeerConnection();
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.iceCandidates.push(event.candidate);
    };
    this.pc.onicegatheringstatechange = () => {
      // Notify the hook to flush new candidates immediately.
      if (this.pc?.iceGatheringState === 'complete') this.onIceGatheringComplete?.();
    };
    this.pc.onconnectionstatechange = () => this.handleConnectionState();
    this.pc.ontrack = (event) => {
      this.remoteStream = event.streams[0];
      this.onRemoteStream(this.remoteStream);
    };
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream!);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription!.sdp;
  }

  /** Set the remote offer and create an answer. */
  async handleOffer(sdp: string): Promise<string> {
    if (!this.localStream) throw new Error('Microphone not yet authorized.');
    this.pc = this.createPeerConnection();
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.iceCandidates.push(event.candidate);
    };
    this.pc.onicegatheringstatechange = () => {
      if (this.pc?.iceGatheringState === 'complete') this.onIceGatheringComplete?.();
    };
    this.pc.onconnectionstatechange = () => this.handleConnectionState();
    this.pc.ontrack = (event) => {
      this.remoteStream = event.streams[0];
      this.onRemoteStream(this.remoteStream);
    };
    for (const track of this.localStream.getTracks()) this.pc.addTrack(track, this.localStream!);
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    // Flush any ICE candidates we received before the offer.
    for (const cand of this.remoteCandidates) {
      try { await this.pc.addIceCandidate(cand); } catch { /* ignore */ }
    }
    this.remoteCandidates = [];
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return this.pc.localDescription!.sdp;
  }

  /** Apply a remote answer. */
  async handleAnswer(sdp: string) {
    if (!this.pc) throw new Error('No peer connection.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  /** Add a remote ICE candidate. Buffer until remote description is set. */
  addIceCandidate(candidate: RTCIceCandidateInit | null) {
    if (!candidate) {
      // end-of-candidates marker — nothing to do
      return;
    }
    if (this.pc && this.pc.remoteDescription) {
      this.pc.addIceCandidate(candidate).catch(() => {});
    } else {
      this.remoteCandidates.push(new RTCIceCandidate(candidate));
    }
  }

  /** Send gathered ICE candidates to the signaling partner (called after offer/answer). */
  getIceCandidates(): RTCIceCandidateInit[] {
    return this.iceCandidates.map((c) => c.toJSON());
  }

  /** Clear buffered ICE candidates after sending. */
  clearIceCandidates() {
    this.iceCandidates = [];
  }

  /** Mute or unmute the local microphone track. */
  setMuted(muted: boolean) {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  /** Full teardown: close PC, stop all tracks, detach audio element. */
  dispose() {
    this.setMuted(true);
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.remoteStream = null;
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement.remove();
      this.audioElement = null;
    }
    this.iceCandidates = [];
    this.remoteCandidates = [];
    this.matchId = null;
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    return pc;
  }

  private handleConnectionState() {
    if (!this.pc) return;
    const state = this.pc.connectionState;
    if (state === 'connected') {
      this.onStateChange('connected');
    } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      this.onStateChange('ended');
    }
  }
}

export type CallState = 'idle' | 'connecting' | 'connected' | 'ended';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];
