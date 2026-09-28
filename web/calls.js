// Copyright (c) 2026 Johannes Thorén. All rights reserved.
// Licensed under the LGJT License v1. See LICENSE in the project root.
//
// Voice/video calls over WebRTC.
//
// • Signaling (ring, join, SDP, leave, …) goes through Veil's end-to-end encrypted channel, so the relay
//   can neither read nor tamper with it. The DTLS fingerprints inside the SDP are therefore authenticated
//   end to end: media keys are negotiated directly between devices and a TURN relay only sees SRTP.
// • 1:1 and group calls use the same model: every device that joins connects to every other joined
//   device (mesh). Fine for small groups (≈ up to 6).
// • Each device pair runs the "perfect negotiation" pattern, so either side can renegotiate at any time
//   (e.g. turning the camera on in an audio call) without offer collisions breaking things.
import { newId } from '../shared/crypto.js';

export const RING_MS = 45_000;
export const CONNECT_MS = 30_000;
const FALLBACK_ICE = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

/** RTCPeerConnection that never fails to construct: bad server entries are dropped, not fatal. */
export function makePeerConnection(iceServers, relayOnly = false) {
  const opts = (servers) => ({ iceServers: servers, bundlePolicy: 'max-bundle', iceTransportPolicy: relayOnly ? 'relay' : 'all' });
  try { return new RTCPeerConnection(opts(iceServers)); } catch (e) { console.warn('ICE config rejected, filtering', e.message); }
  const ok = [];
  for (const s of iceServers ?? []) {
    for (const u of [].concat(s.urls ?? [])) {
      try { new RTCPeerConnection({ iceServers: [{ ...s, urls: [u] }] }).close(); ok.push({ ...s, urls: [u] }); } catch { /* skip */ }
    }
  }
  return new RTCPeerConnection(opts(ok.length ? ok : FALLBACK_ICE));
}

/**
 * Connectivity check for Settings: which kinds of ICE candidates can this device gather?
 * host = local network, srflx = STUN (public address), relay = TURN.
 */
export async function testConnectivity(iceServers, ms = 8000) {
  const result = { host: false, srflx: false, relay: false, servers: iceServers, errors: [] };
  let pc;
  try { pc = makePeerConnection(iceServers); } catch (e) { result.errors.push(e.message); return result; }
  pc.createDataChannel('probe');
  pc.onicecandidate = (e) => {
    const c = e.candidate?.candidate;
    if (!c) return;
    const type = / typ (host|srflx|prflx|relay)/.exec(c)?.[1];
    if (type === 'host') result.host = true;
    if (type === 'srflx' || type === 'prflx') result.srflx = true;
    if (type === 'relay') result.relay = true;
  };
  pc.onicecandidateerror = (e) => { if (e.errorCode && e.errorCode !== 701) result.errors.push(`${e.url ?? ''} ${e.errorCode} ${e.errorText ?? ''}`.trim()); };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
  });
  pc.close();
  return result;
}
const uniq = (a) => [...new Set(a)];

function iceGathered(pc, ms = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

// ---------- tones (generated, no audio files) ----------
class Tones {
  constructor() { this.ctx = null; this.timer = null; this.nodes = []; }
  _ctx() {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    this.ctx.resume?.().catch(() => {});
    return this.ctx;
  }
  _beep(freqs, dur, gain) {
    const ctx = this._ctx();
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(ctx.destination);
    const now = ctx.currentTime;
    g.gain.setTargetAtTime(gain, now, 0.01);
    g.gain.setTargetAtTime(0, now + dur, 0.02);
    for (const f of freqs) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(g);
      o.start(now);
      o.stop(now + dur + 0.2);
    }
  }
  /** Incoming: two short double-rings, then a pause. */
  ring() {
    this.stop();
    const play = () => { try { this._beep([440, 480], 0.4, 0.12); setTimeout(() => this._beep([440, 480], 0.4, 0.12), 600); } catch { /* audio blocked */ } };
    play();
    this.timer = setInterval(play, 3000);
    try { navigator.vibrate?.([400, 200, 400]); } catch { /* ignore */ }
  }
  /** Outgoing: European ringback, 425 Hz one second on, four off. */
  ringback() {
    this.stop();
    const play = () => { try { this._beep([425], 1, 0.06); } catch { /* ignore */ } };
    play();
    this.timer = setInterval(play, 5000);
  }
  end() { try { this._beep([480], 0.15, 0.08); setTimeout(() => this._beep([380], 0.25, 0.08), 180); } catch { /* ignore */ } }
  stop() { clearInterval(this.timer); this.timer = null; try { navigator.vibrate?.(0); } catch { /* ignore */ } }
}

export class CallManager {
  constructor(client) {
    this.client = client;
    this.call = null;        // the call this device is in
    this.incoming = null;    // a call ringing on this device
    this.ongoing = new Map(); // callId -> { chatId, video, accounts, joined:Set<"acct:dev"> } for calls we know are running
    this.tones = new Tones();
    this._listeners = new Set();
    client.on('call', (s) => this._onSignal(s).catch((e) => console.warn('call signal failed', s.c?.op, e)));
  }
  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) try { fn(); } catch (e) { console.error(e); } }

  get me() { return this.client.me; }
  key(a, d) { return `${a}:${d}`; }
  get myKey() { return this.key(this.me.account, this.me.deviceId); }

  // ---------------------------------------------------------------- public API
  /** Start a call in a DM or group chat. */
  async start(chatId, video) {
    if (this.call) throw new Error('You are already in a call');
    const chat = await this.client.chat(chatId);
    if (!chat) throw new Error('No such chat');
    let accounts;
    if (chat.kind === 'dm') accounts = [chat.peer];
    else {
      const g = await this.client.group(chat.gid);
      if (!g?.members.includes(this.me.account)) throw new Error('You are not in this group');
      accounts = g.members.filter((a) => a !== this.me.account);
    }
    if (!accounts.length) throw new Error('Nobody else is in this chat');
    const local = await this._media(video);
    const id = newId();
    this.call = this._newCall({ id, chatId, kind: chat.kind, gid: chat.gid, video, dir: 'out', status: 'ringing', accounts: uniq([this.me.account, ...accounts]), local });
    this.ongoing.set(id, { chatId, video, accounts: this.call.accounts, joined: new Set([this.myKey]) });
    this.tones.ringback();
    this._emit();
    try {
      const targets = await this.client.callDevices(accounts);
      await this.client.sendCall(targets, {
        op: 'ring', id, video: !!video, accounts: this.call.accounts, profile: this.client._profileTag,
        chat: chat.kind === 'dm' ? { dm: true } : { group: chat.gid },
      }, { push: true });
    } catch (e) {
      this._end('failed');
      throw e;
    }
    this.call.ringTimer = setTimeout(() => {
      if (this.call?.id === id && this.call.peers.size === 0) this.hangup('no-answer');
    }, RING_MS);
  }

  /** Answer the ringing call. */
  async accept(video = this.incoming?.video) {
    const inc = this.incoming;
    if (!inc) return;
    this.tones.stop();
    clearTimeout(inc.timer);
    this.incoming = null;
    await this._join(inc, video);
  }

  /** Join a group call that's already running (e.g. after missing the ring). */
  async joinOngoing(chatId, video = false) {
    const [id, o] = [...this.ongoing].find(([, v]) => v.chatId === chatId && v.joined.size > 0) ?? [];
    if (!id) throw new Error('No call to join');
    await this._join({ id, chatId, kind: 'group', gid: chatId.slice(2), video: o.video, accounts: o.accounts, from: null }, video);
  }

  decline() {
    const inc = this.incoming;
    if (!inc) return;
    this.tones.stop();
    clearTimeout(inc.timer);
    this.incoming = null;
    this.client.logCall(inc.chatId, { video: inc.video, dir: 'in', status: 'declined', from: inc.from.a });
    this._emit();
    // tell the caller (1:1 ends there) and my other devices (they stop ringing)
    this.client.callDevices(inc.accounts.filter((a) => a !== this.me.account))
      .then((t) => this.client.sendCall(t, { op: 'decline', id: inc.id })).catch(() => {});
  }

  async hangup(reason = 'ended') {
    const call = this.call;
    if (!call) return;
    this._end(reason);
    try {
      const targets = await this.client.callDevices(call.accounts.filter((a) => a !== this.me.account));
      await this.client.sendCall(targets, { op: 'leave', id: call.id });
    } catch { /* offline: peers notice the connection drop */ }
  }

  toggleMute() {
    const c = this.call;
    if (!c) return;
    c.muted = !c.muted;
    for (const t of c.local.getAudioTracks()) t.enabled = !c.muted;
    this._announceMedia();
    this._emit();
  }

  async toggleCamera() {
    const c = this.call;
    if (!c) return;
    const track = c.local.getVideoTracks()[0];
    if (!track) {
      // audio call → add a camera track; each peer renegotiates (perfect negotiation handles it)
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: c.facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
      const vt = s.getVideoTracks()[0];
      c.local.addTrack(vt);
      for (const p of c.peers.values()) p.pc.addTrack(vt, c.local);
      c.camOff = false;
      c.video = true;
    } else {
      c.camOff = !c.camOff;
      track.enabled = !c.camOff;
    }
    this._announceMedia();
    this._emit();
  }

  async switchCamera() {
    const c = this.call;
    const old = c?.local.getVideoTracks()[0];
    if (!old) return;
    c.facing = c.facing === 'user' ? 'environment' : 'user';
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: c.facing } } })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: c.facing } }));
    const nt = s.getVideoTracks()[0];
    nt.enabled = !c.camOff;
    for (const p of c.peers.values()) {
      const sender = p.pc.getSenders().find((x) => x.track?.kind === 'video');
      await sender?.replaceTrack(nt);
    }
    c.local.removeTrack(old);
    old.stop();
    c.local.addTrack(nt);
    this._emit();
  }

  // ---------------------------------------------------------------- internals
  _newCall(o) {
    return { peers: new Map(), muted: false, camOff: false, facing: 'user', started: null, ringTimer: null, ...o };
  }

  async _media(video) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need HTTPS (and a browser with camera/microphone access)');
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
    } catch (e) {
      if (video) {
        // no camera / camera denied → fall back to audio instead of failing the call
        try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch { /* fall through */ }
      }
      throw new Error(e.name === 'NotAllowedError' ? 'Allow microphone access to make calls' : `Can't access microphone: ${e.message}`);
    }
  }

  async _join(info, video) {
    if (this.call) throw new Error('You are already in a call');
    const local = await this._media(video);
    this.call = this._newCall({
      id: info.id, chatId: info.chatId, kind: info.kind, gid: info.gid, video: !!local.getVideoTracks().length,
      dir: 'in', status: 'connecting', accounts: info.accounts, from: info.from?.a ?? null, local,
    });
    const o = this.ongoing.get(info.id);
    o?.joined.add(this.myKey);
    this._emit();
    // Everyone already in the call connects to us (they send the offers).
    const targets = await this.client.callDevices(info.accounts.filter((a) => a !== this.me.account));
    await this.client.sendCall(targets, { op: 'join', id: info.id, profile: this.client._profileTag });
    const id = info.id;
    this.call.ringTimer = setTimeout(() => {
      if (this.call?.id === id && ![...this.call.peers.values()].some((p) => p.state === 'connected')) this.hangup('failed');
    }, CONNECT_MS);
  }

  _end(reason) {
    const c = this.call;
    if (!c) return;
    this.call = null;
    clearTimeout(c.ringTimer);
    this.tones.stop();
    if (c.status === 'active' || reason !== 'ended') this.tones.end();
    for (const p of c.peers.values()) try { p.pc.close(); } catch { /* ignore */ }
    for (const t of c.local.getTracks()) t.stop();
    const o = this.ongoing.get(c.id);
    o?.joined.delete(this.myKey);
    const duration = c.started ? Math.round((Date.now() - c.started) / 1000) : 0;
    const status = duration ? 'ended' : reason;
    this.client.logCall(c.chatId, { video: c.video, dir: c.dir, status, duration, from: c.from });
    this.lastEnd = { reason: status, at: Date.now() };
    this._emit();
  }

  async _announceMedia() {
    const c = this.call;
    if (!c) return;
    const targets = [...c.peers.values()].map((p) => ({ a: p.a, d: p.d }));
    if (targets.length) this.client.sendCall(targets, { op: 'media', id: c.id, mic: !c.muted, cam: c.video && !c.camOff }).catch(() => {});
  }

  async _peer(a, d) {
    const c = this.call;
    const k = this.key(a, d);
    if (c.peers.has(k)) return c.peers.get(k);
    // localStorage "veil-relay" = "1" forces every call through TURN (useful to test your TURN server)
    let relayOnly = false;
    try { relayOnly = localStorage.getItem('veil-relay') === '1'; } catch { /* ignore */ }
    const pc = makePeerConnection(await this.client.iceServers().catch(() => []), relayOnly);
    const p = {
      a, d, pc, stream: new MediaStream(), state: 'connecting',
      polite: this.myKey > k, makingOffer: false, ignoreOffer: false, tracksAdded: false,
      mic: true, cam: true,
    };
    c.peers.set(k, p);
    const send = (desc) => this.client.sendCall([{ a, d }], { op: 'sdp', id: c.id, desc: { type: desc.type, sdp: desc.sdp } });
    pc.ontrack = ({ track }) => {
      if (!p.stream.getTracks().includes(track)) p.stream.addTrack(track);
      track.onunmute = () => this._emit();
      track.onmute = () => this._emit();
      track.onended = () => { p.stream.removeTrack(track); this._emit(); };
      this._emit();
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      if (p.state === 'connected' && this.call === c) {
        clearTimeout(c.ringTimer);
        if (c.status !== 'active') { c.status = 'active'; c.started ??= Date.now(); this.tones.stop(); }
      }
      if (p.state === 'failed') pc.restartIce();
      if (p.state === 'closed') this._dropPeer(k);
      this._emit();
    };
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        await iceGathered(pc);
        await send(pc.localDescription);
      } catch (e) { console.warn('negotiation', e); } finally { p.makingOffer = false; }
    };
    p.send = send;
    p.addTracks = () => {
      if (p.tracksAdded) return;
      p.tracksAdded = true;
      for (const t of c.local.getTracks()) pc.addTrack(t, c.local);
    };
    return p;
  }

  _dropPeer(k) {
    const c = this.call;
    if (!c) return;
    const p = c.peers.get(k);
    if (!p) return;
    c.peers.delete(k);
    try { p.pc.close(); } catch { /* ignore */ }
    // 1:1 ends when the other side goes; a group call ends when we're the last one left
    if (c.kind === 'dm' || (c.peers.size === 0 && c.status === 'active')) this._end(c.status === 'active' ? 'ended' : 'failed');
    else this._emit();
  }

  _chatFor(from, c) {
    if (c.chat?.group) return `g:${c.chat.group}`;
    return `dm:${from.a}`;
  }

  async _onSignal({ from, c, ts }) {
    const mine = from.a === this.me.account;
    const k = this.key(from.a, from.d);
    const call = this.call?.id === c.id ? this.call : null;

    switch (c.op) {
      case 'ring': {
        if (mine) return; // placed from another of my devices
        const accounts = Array.isArray(c.accounts) ? uniq(c.accounts.filter((a) => typeof a === 'string' && a.length === 16)) : [];
        if (!accounts.includes(this.me.account) || !accounts.includes(from.a) || accounts.length > 32) return;
        let chatId;
        if (c.chat?.group) {
          const g = await this.client.group(c.chat.group);
          if (!g || !g.members.includes(this.me.account) || !g.members.includes(from.a)) return;
          chatId = `g:${g.id}`;
        } else {
          const contact = await this.client.contact(from.a);
          if (!contact || contact.status !== 'accepted') return; // only contacts can ring you
          chatId = `dm:${from.a}`;
        }
        const info = { id: c.id, chatId, kind: c.chat?.group ? 'group' : 'dm', gid: c.chat?.group, video: !!c.video, from, accounts };
        this.ongoing.set(c.id, { chatId, video: info.video, accounts, joined: new Set([k]) });
        if (Date.now() - ts > RING_MS) { this.client.logCall(chatId, { video: info.video, dir: 'in', status: 'missed', from: from.a }); return; }
        if (this.call || this.incoming) {
          if (info.kind === 'dm') this.client.sendCall([{ a: from.a, d: from.d }], { op: 'busy', id: c.id }).catch(() => {});
          this.client.logCall(chatId, { video: info.video, dir: 'in', status: 'missed', from: from.a });
          return;
        }
        this.incoming = info;
        info.timer = setTimeout(() => {
          if (this.incoming?.id !== c.id) return;
          this.incoming = null;
          this.tones.stop();
          this.client.logCall(chatId, { video: info.video, dir: 'in', status: 'missed', from: from.a });
          this._emit();
        }, RING_MS - Math.max(0, Date.now() - ts));
        this.tones.ring();
        this._emit();
        return;
      }
      case 'join': {
        const o = this.ongoing.get(c.id);
        if (o && o.accounts.includes(from.a)) o.joined.add(k);
        if (this.incoming?.id === c.id && mine) {
          // answered on another of my devices
          clearTimeout(this.incoming.timer);
          this.incoming = null;
          this.tones.stop();
          this._emit();
          return;
        }
        if (call && k !== this.myKey && call.accounts.includes(from.a)) {
          // We're already in: connect to the newcomer. Adding our tracks triggers the offer.
          const p = await this._peer(from.a, from.d);
          p.addTracks();
          if (call.status === 'ringing') {
            call.status = 'connecting';
            clearTimeout(call.ringTimer);
            const id = call.id;
            call.ringTimer = setTimeout(() => {
              if (this.call?.id === id && this.call.status !== 'active') this.hangup('failed');
            }, CONNECT_MS);
          }
          this.tones.stop();
          this._emit();
        }
        return;
      }
      case 'sdp': {
        if (!call || !call.accounts.includes(from.a) || !c.desc?.type) return;
        const p = await this._peer(from.a, from.d);
        const pc = p.pc;
        const desc = { type: c.desc.type, sdp: String(c.desc.sdp ?? '') };
        const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          p.addTracks(); // a newcomer attaches its tracks to the offered transceivers
          await pc.setLocalDescription();
          await iceGathered(pc);
          await p.send(pc.localDescription);
        }
        return;
      }
      case 'media': {
        const p = call?.peers.get(k);
        if (p) { p.mic = c.mic !== false; p.cam = c.cam !== false; this._emit(); }
        return;
      }
      case 'leave': {
        const o = this.ongoing.get(c.id);
        o?.joined.delete(k);
        if (o && o.joined.size === 0) this.ongoing.delete(c.id);
        if (this.incoming?.id === c.id && (!o || o.joined.size === 0)) {
          // caller hung up before we answered
          const inc = this.incoming;
          clearTimeout(inc.timer);
          this.incoming = null;
          this.tones.stop();
          this.client.logCall(inc.chatId, { video: inc.video, dir: 'in', status: 'missed', from: inc.from.a });
        }
        if (call) this._dropPeer(k);
        this._emit();
        return;
      }
      case 'decline': {
        if (this.incoming?.id === c.id && mine) {
          clearTimeout(this.incoming.timer);
          this.incoming = null;
          this.tones.stop();
        } else if (call && call.kind === 'dm' && call.dir === 'out' && !mine && call.peers.size === 0) {
          this._end('declined');
        }
        this._emit();
        return;
      }
      case 'busy': {
        if (call && call.kind === 'dm' && call.peers.size === 0) this._end('busy');
        return;
      }
    }
  }
}
