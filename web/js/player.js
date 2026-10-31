// Plays songs with one plain <audio> element (Web Audio would stop the music
// in the background on iPhone), and drives the lock-screen controls through
// the Media Session API.

import * as Q from './queue.js';

const SAVE_EVERY_MS = 4000;

export class Player extends EventTarget {
  /**
   * @param {HTMLAudioElement} audio
   * @param {object} lib  { song(id), fileUrl(song) -> Promise<url>, artwork(song) -> [MediaImage],
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
    this.urls = new Map(); // song id -> object URL, kept for the current, next and previous songs
    this.lastRemote = null; // last lock-screen button press, shown in Settings
    try { this.lastRemote = JSON.parse(localStorage.getItem('lastRemote')); } catch (e) {}
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
    a.addEventListener('playing', () => {
      this.errors = 0;
      // iPhone sometimes drops the Now Playing info when the song changes; set it again.
      this.setActions();
      this.updateMetadata(this.song);
      this.updateSession();
    });
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

  // Loads the current queue entry. When its file URL is already prepared this
  // runs without waiting, which matters on iPhone: a lock-screen button press
  // only counts as a tap if play() is called straight away.
  load({ autoplay = true, at = 0 } = {}) {
    const token = ++this.loadToken;
    const entry = Q.currentEntry(this.q);
    this.emit('queue');
    this.emit('song');
    if (!entry) {
      this.stop();
      return Promise.resolve();
    }
    const song = this.lib.song(entry.id);
    const ready = this.urls.get(song.id);
    if (ready) return this.start(entry, song, ready, autoplay, at);
    return this.urlFor(song).then(
      (url) => (token === this.loadToken ? this.start(entry, song, url, autoplay, at) : undefined),
      (e) => { if (token === this.loadToken) this.onError(e); },
    );
  }

  start(entry, song, url, autoplay, at) {
    this.url = url;
    this.loadedKey = entry.k;
    this.pendingSeek = at > 0 ? at : null;
    this.audio.src = url;
    const playing = autoplay ? this.play() : (this.audio.load(), Promise.resolve());
    this.updateMetadata(song);
    this.save(true);
    this.prepareNeighbours();
    return playing;
  }

  async urlFor(song) {
    let url = this.urls.get(song.id);
    if (!url) {
      url = await this.lib.fileUrl(song);
      const again = this.urls.get(song.id);
      if (again) { URL.revokeObjectURL(url); return again; }
      this.urls.set(song.id, url);
    }
    return url;
  }

  // Gets the previous and next songs' files ready, and frees the rest.
  prepareNeighbours() {
    const q = this.q;
    const n = q.items.length;
    const keep = new Set();
    for (const d of [-1, 0, 1]) {
      let i = q.index + d;
      if (i < 0 || i >= n) {
        if (q.repeat !== 'all' || !n) continue;
        i = (i + n) % n;
      }
      keep.add(q.items[i].id);
    }
    for (const [id, url] of this.urls) {
      if (!keep.has(id) && url !== this.url) {
        this.urls.delete(id);
        URL.revokeObjectURL(url);
      }
    }
    for (const id of keep) {
      const s = this.lib.song(id);
      if (s) this.urlFor(s).catch(() => {});
    }
  }

  async play() {
    if (!Q.current(this.q)) return;
    if (this.loadedKey !== Q.currentEntry(this.q).k) return this.load({ autoplay: true });
    try {
      await this.audio.play(); // called synchronously; only the result is awaited
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
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
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
    this.prepareNeighbours();
    this.emit('queue');
    this.save(true);
  }

  cycleRepeat() {
    this.q = Q.cycleRepeat(this.q);
    this.prepareNeighbours();
    this.emit('queue');
    this.save(true);
  }

  playNext(ids) {
    const wasEmpty = !this.q.items.length;
    this.q = Q.playNext(this.q, ids);
    if (wasEmpty) return this.load({ autoplay: true });
    this.prepareNeighbours();
    this.emit('queue');
    this.save(true);
  }

  addToQueue(ids) {
    const wasEmpty = !this.q.items.length;
    this.q = Q.addToQueue(this.q, ids);
    if (wasEmpty) return this.load({ autoplay: true });
    this.prepareNeighbours();
    this.emit('queue');
    this.save(true);
  }

  removeAt(i) {
    const wasCurrent = i === this.q.index;
    const wasPlaying = this.playing;
    this.q = Q.removeAt(this.q, i);
    if (wasCurrent) return this.load({ autoplay: wasPlaying });
    this.prepareNeighbours();
    this.emit('queue');
    this.save(true);
  }

  move(from, to) {
    this.q = Q.move(this.q, from, to);
    this.prepareNeighbours();
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
    const set = (name, fn) => {
      const wrapped = fn && ((d) => { this.lastRemote = { action: name, at: Date.now() };
        try { localStorage.setItem('lastRemote', JSON.stringify(this.lastRemote)); } catch (e) {}
        this.emit('remote'); fn(d || {}); });
      try { ms.setActionHandler(name, wrapped); } catch (e) {}
    };
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

  // Artwork must be a normal web address: iPhone ignores data: and blob: pictures
  // on the lock screen. The service worker serves art/<key> from the app's storage.
  updateMetadata(song) {
    if (!('mediaSession' in navigator) || !song) return;
    const m = navigator.mediaSession.metadata;
    const artwork = this.lib.artwork(song);
    if (m && m.title === song.title && m.artist === song.artist && m.album === song.album &&
        m.artwork && m.artwork[0] && m.artwork[0].src === artwork[0].src) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: song.title, artist: song.artist, album: song.album, artwork });
    } catch (e) {}
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
