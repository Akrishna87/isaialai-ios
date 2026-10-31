// Plays songs with one plain <audio> element (Web Audio would stop the music
// in the background on iPhone), and drives the lock-screen controls through
// the Media Session API.

import * as Q from './queue.js';

const SAVE_EVERY_MS = 4000;

export class Player extends EventTarget {
  /**
   * @param {HTMLAudioElement} audio
   * @param {object} lib  { song(id), fileUrl(song) -> Promise<url>, artDataUrl(song) -> Promise<url|null>,
   *                        load() -> Promise<saved>, save(saved), settings() }
   */
  constructor(audio, lib) {
    super();
    this.audio = audio;
    this.lib = lib;
    this.q = Q.emptyQueue();
    this.loadedKey = null; // queue entry key whose file is in the audio element
    this.url = null;
    this.errors = 0;
    this.lastSave = 0;
    this.pendingSeek = null;
    this.loadToken = 0;
    this.bind();
  }

  get song() {
    const id = Q.current(this.q);
    return id ? this.lib.song(id) : null;
  }

  get playing() {
    return !this.audio.paused && !this.audio.ended;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  bind() {
    const a = this.audio;
    a.preload = 'auto';
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('play', () => { this.emit('state'); this.updateSession(); });
    a.addEventListener('pause', () => { this.emit('state'); this.updateSession(); this.save(true); });
    a.addEventListener('playing', () => { this.errors = 0; this.updatePosition(); });
    a.addEventListener('timeupdate', () => {
      this.emit('time');
      if (Date.now() - this.lastSave > SAVE_EVERY_MS) this.save();
    });
    a.addEventListener('durationchange', () => { this.emit('time'); this.updatePosition(); this.noteDuration(); });
    a.addEventListener('loadedmetadata', () => {
      if (this.pendingSeek != null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        if (t > 0 && (!a.duration || t < a.duration - 1)) a.currentTime = t;
      }
    });
    a.addEventListener('error', () => this.onError());
    const flush = () => this.save(true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
    this.setupSession();
  }

  // ---- Saving and restoring ----

  async restore() {
    const saved = await this.lib.load();
    if (!saved || !saved.queue) return;
    let q = Q.sanitize(saved.queue);
    const gone = new Set(q.items.map((e) => e.id).filter((id) => !this.lib.song(id)));
    if (gone.size) q = Q.removeSongs(q, gone);
    this.q = q;
    this.emit('queue');
    if (Q.current(q)) await this.load({ autoplay: false, at: saved.time || 0 });
  }

  save(force = false) {
    if (!force && Date.now() - this.lastSave < 1000) return;
    this.lastSave = Date.now();
    const time = this.loadedKey != null ? this.audio.currentTime || this.pendingSeek || 0 : 0;
    this.lib.save({ queue: this.q, time });
  }

  noteDuration() {
    const s = this.song;
    const d = this.audio.duration;
    if (s && isFinite(d) && d > 0 && Math.abs((s.durationMs || 0) - d * 1000) > 1500) this.lib.setDuration(s, Math.round(d * 1000));
  }

  // ---- Loading songs ----

  async load({ autoplay = true, at = 0 } = {}) {
    const token = ++this.loadToken;
    const entry = Q.currentEntry(this.q);
    this.emit('queue');
    this.emit('song');
    if (!entry) {
      this.stop();
      return;
    }
    const song = this.lib.song(entry.id);
    let url;
    try {
      url = await this.lib.fileUrl(song);
    } catch (e) {
      if (token === this.loadToken) this.onError(e);
      return;
    }
    if (token !== this.loadToken) { URL.revokeObjectURL(url); return; }
    const old = this.url;
    this.url = url;
    this.loadedKey = entry.k;
    this.pendingSeek = at > 0 ? at : null;
    this.audio.src = url;
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    this.updateMetadata(song);
    this.save(true);
    if (autoplay) await this.play();
    else this.audio.load();
  }

  async play() {
    if (!Q.current(this.q)) return;
    if (this.loadedKey !== Q.currentEntry(this.q).k) return this.load({ autoplay: true });
    try {
      await this.audio.play();
    } catch (e) {
      // NotAllowedError: iOS wants a tap first. AbortError: a newer load replaced this one.
      this.emit('state');
    }
  }

  pause() { this.audio.pause(); }

  toggle() { this.playing ? this.pause() : this.play(); }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.loadedKey = null;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    this.emit('state');
    this.save(true);
  }

  // ---- Queue actions ----

  playList(ids, start = 0, opts = {}) {
    this.q = Q.setQueue(this.q, ids, start, opts);
    return this.load({ autoplay: true });
  }

  shuffleAll(ids) {
    this.q = Q.shuffleAll(this.q, ids);
    return this.load({ autoplay: true });
  }

  next() {
    const n = Q.next(this.q, { auto: false });
    if (!n) {
      // End of the queue: go back to the start, paused.
      this.q = { ...this.q, index: 0 };
      return this.load({ autoplay: false });
    }
    this.q = n;
    return this.load({ autoplay: true });
  }

  prev() {
    if (this.audio.currentTime > 3) {
      this.seek(0);
      return;
    }
    this.q = Q.prev(this.q);
    return this.load({ autoplay: true });
  }

  onEnded() {
    const n = Q.next(this.q, { auto: true });
    if (!n) {
      this.q = { ...this.q, index: 0 };
      this.load({ autoplay: false });
      return;
    }
    const same = Q.currentEntry(n).k === this.loadedKey;
    this.q = n;
    if (same) {
      this.audio.currentTime = 0;
      this.play();
    } else this.load({ autoplay: true });
  }

  onError() {
    if (!Q.current(this.q)) return;
    this.errors++;
    this.dispatchEvent(new CustomEvent('message', { detail: "Couldn't play " + (this.song ? this.song.title : 'this song') }));
    if (this.errors >= Math.min(5, this.q.items.length)) {
      this.errors = 0;
      this.audio.pause();
      this.emit('state');
      return;
    }
    const n = Q.next(this.q, { auto: false });
    if (n) {
      this.q = n;
      this.load({ autoplay: true });
    }
  }

  jumpTo(i) {
    this.q = Q.jumpTo(this.q, i);
    return this.load({ autoplay: true });
  }

  toggleShuffle() {
    this.q = Q.toggleShuffle(this.q);
    this.emit('queue');
    this.save(true);
  }

  cycleRepeat() {
    this.q = Q.cycleRepeat(this.q);
    this.emit('queue');
    this.save(true);
  }

  playNext(ids) {
    const wasEmpty = !this.q.items.length;
    this.q = Q.playNext(this.q, ids);
    if (wasEmpty) return this.load({ autoplay: true });
    this.emit('queue');
    this.save(true);
  }

  addToQueue(ids) {
    const wasEmpty = !this.q.items.length;
    this.q = Q.addToQueue(this.q, ids);
    if (wasEmpty) return this.load({ autoplay: true });
    this.emit('queue');
    this.save(true);
  }

  removeAt(i) {
    const wasCurrent = i === this.q.index;
    const wasPlaying = this.playing;
    this.q = Q.removeAt(this.q, i);
    if (wasCurrent) return this.load({ autoplay: wasPlaying });
    this.emit('queue');
    this.save(true);
  }

  move(from, to) {
    this.q = Q.move(this.q, from, to);
    this.emit('queue');
    this.save(true);
  }

  // Called after songs are deleted from the library.
  removeSongs(idSet) {
    const cur = Q.currentEntry(this.q);
    const wasPlaying = this.playing;
    this.q = Q.removeSongs(this.q, idSet);
    if (cur && idSet.has(cur.id)) return this.load({ autoplay: wasPlaying });
    this.emit('queue');
    this.save(true);
  }

  // ---- Seeking ----

  seek(t) {
    const d = this.audio.duration;
    if (!isFinite(d)) return;
    this.audio.currentTime = Math.max(0, Math.min(t, d - 0.25));
    this.updatePosition();
    this.emit('time');
  }

  skip(sec) { this.seek(this.audio.currentTime + sec); }

  // ---- Lock screen / Control Centre ----

  setupSession() {
    if (!('mediaSession' in navigator)) return;
    this.setActions();
  }

  // iPhone shows either ⏮ ⏭ (previous/next song) or ⏪ ⏩ (10 seconds) on the
  // lock screen: if the seek handlers are set it shows those instead of the
  // track buttons. So we let the person choose; songs is the default.
  setActions() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const seekButtons = this.lib.settings().lockButtons === 'seek';
    const set = (name, fn) => { try { ms.setActionHandler(name, fn); } catch (e) {} };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('stop', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekto', (d) => {
      if (d.fastSeek && 'fastSeek' in this.audio) this.audio.fastSeek(d.seekTime);
      else this.seek(d.seekTime);
      this.updatePosition();
    });
    set('seekbackward', seekButtons ? (d) => this.skip(-(d.seekOffset || 10)) : null);
    set('seekforward', seekButtons ? (d) => this.skip(d.seekOffset || 10) : null);
  }

  async updateMetadata(song) {
    if (!('mediaSession' in navigator) || !song) return;
    const base = { title: song.title, artist: song.artist, album: song.album };
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ ...base, artwork: this.lib.defaultArtwork() });
    } catch (e) { return; }
    const art = await this.lib.artDataUrl(song);
    if (art && this.song === song) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ ...base, artwork: [{ src: art.src, sizes: art.sizes, type: art.type }] });
      } catch (e) {}
    }
  }

  updateSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    this.updatePosition();
  }

  updatePosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const a = this.audio;
    if (!isFinite(a.duration) || a.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: a.duration,
        playbackRate: a.playbackRate || 1,
        position: Math.min(a.currentTime, a.duration),
      });
    } catch (e) {}
  }
}
