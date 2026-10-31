// Backup and restore, in the same "Isaialai backup.json" format as the Android
// app (format 1), so a backup from either phone can be restored on the other.
//
// Songs are listed once in "songs" as {path, title, artist, album, durationMs}
// and referred to by their position in that list. On iPhone there are no
// folders, so "path" is just "/" + the file name.
// Pure functions (no browser APIs), so they can be tested in Node.

export const BACKUP_NAME = 'Isaialai backup.json';
const FORMAT = 1;

export function refOf(song) {
  return {
    // Songs from an Android zip keep their folder ("Music/Hindi/x.mp3"), which the Android app matches exactly.
    path: '/' + (song.path || song.fileName || song.title),
    title: song.title || '',
    artist: song.artist || '',
    album: song.album || '',
    durationMs: song.durationMs || 0,
  };
}

const refKey = (r) => JSON.stringify([r.path, r.title, r.artist, r.album, r.durationMs]);

/**
 * @param {object} d { songs: Map|Array of songs, playlists: [{name, songs:[id]}], liked: [id], settings, now }
 * @returns {string} the backup file's text
 */
export function makeBackup({ songs, playlists = [], liked = [], settings = {}, now = Date.now(), pending = null }) {
  const byId = songs instanceof Map ? songs : new Map(songs.map((s) => [s.id, s]));
  const list = [];
  const index = new Map();
  const ref = (r) => {
    const k = refKey(r);
    if (!index.has(k)) { index.set(k, list.length); list.push(r); }
    return index.get(k);
  };
  // Songs not added to this iPhone yet (from a restore) stay in the backup.
  const pendingFor = (pid) => (pending && pending.playlists && pending.playlists[pid]) || [];
  const refsOf = (ids, extra = []) => [
    ...ids.map((id) => byId.get(id)).filter(Boolean).map((s) => ref(refOf(s))),
    ...extra.map(ref),
  ];
  const o = {
    app: 'Isaialai',
    format: FORMAT,
    created: isoWithZone(new Date(now)),
    createdMs: now,
    from: 'iPhone',
    playlists: playlists.map((p) => ({ name: p.name, songs: refsOf(p.songs, pendingFor(p.id)) })),
    liked: refsOf(liked, (pending && pending.liked) || []),
    history: [],
    plays: [],
    edits: [],
    settings: { ios: { ...settings } },
    listens: [],
  };
  o.songs = list; // last, so the readable parts come first (like Android)
  return JSON.stringify(o, null, 1);
}

// "2026-10-31T21:50:00+0530", like Android's SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssZ").
function isoWithZone(d) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

/** Reads a backup's text. Returns null if it isn't an Isaialai backup. */
export function parseBackup(text) {
  let o;
  try {
    o = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    return null;
  }
  if (!o || o.app !== 'Isaialai' || !Array.isArray(o.songs)) return null;
  const songs = o.songs.map((s) => ({
    path: String((s && s.path) || ''),
    title: String((s && s.title) || ''),
    artist: String((s && s.artist) || ''),
    album: String((s && s.album) || ''),
    durationMs: Number((s && s.durationMs) || 0) || 0,
  }));
  const at = (i) => (Number.isInteger(i) && i >= 0 && i < songs.length ? songs[i] : null);
  const list = (a) => (Array.isArray(a) ? a.map(at).filter(Boolean) : []);
  const objects = (a) => (Array.isArray(a) ? a.filter((x) => x && typeof x === 'object') : []);
  return {
    createdMs: Number(o.createdMs) || 0,
    from: o.from === 'iPhone' ? 'iPhone' : 'Android',
    playlists: objects(o.playlists).map((p) => ({ name: String(p.name || '').trim() || 'Playlist', songs: list(p.songs) })),
    liked: list(o.liked),
    plays: objects(o.plays).length,
    settings: o.settings && typeof o.settings === 'object' && o.settings.ios && typeof o.settings.ios === 'object' ? o.settings.ios : null,
  };
}

// ---- Finding backed-up songs among this iPhone's songs (like Android's SongMatcher) ----

const normName = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
const gap = (s, ms) => (!ms || !s.durationMs ? 0 : Math.abs(s.durationMs - ms));
const UNKNOWN = new Set(['', 'unknownartist', 'unknown']);
// Path after the storage it's on: "music/hindi/x.mp3" from "/storage/emulated/0/Music/Hindi/x.mp3".
const STORAGE = /^(\/storage\/emulated\/\d+\/|\/storage\/self\/primary\/|\/mnt\/sdcard\/|\/sdcard\/|\/storage\/[^/]+\/|[a-z]:\/)/;
const relative = (p) => String(p || '').replace(/\\/g, '/').toLowerCase().replace(STORAGE, '').replace(/^\/+|\/+$/g, '');
// How many path parts two paths share at the end ("hindi/x.mp3" = 2).
function sameEnding(a, b) {
  const x = a.split('/').reverse();
  const y = b.split('/').reverse();
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export class SongMatcher {
  constructor(songs) {
    this.byFile = new Map();
    this.byTitle = new Map();
    const add = (m, k, s) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(s); };
    for (const s of songs) {
      add(this.byFile, (s.fileName || '').toLowerCase(), s);
      add(this.byTitle, normName(s.title), s);
    }
  }

  /** Returns the song on this iPhone that the backup's ref means, or null. */
  find(ref) {
    const ms = ref.durationMs || 0;
    const closest = (list) => list.reduce((a, b) => (gap(b, ms) < gap(a, ms) ? b : a));
    const file = baseName(ref.path);
    const sameFile = file && this.byFile.get(file);
    if (sameFile) {
      // The copy whose folders match the most (several albums can have "01.mp3"), then the closest length.
      const rel = relative(ref.path);
      const score = (s) => (s.path ? sameEnding(relative(s.path), rel) : 1);
      const best = sameFile.reduce((a, b) => (score(b) > score(a) || (score(b) === score(a) && gap(b, ms) < gap(a, ms)) ? b : a));
      if (score(best) >= 2 || !ms || gap(best, ms) <= 5000) return best;
    }
    const title = normName(ref.title);
    if (!title) return null;
    const candidates = (this.byTitle.get(title) || []).filter((s) => !ms || !s.durationMs || gap(s, ms) <= 5000);
    if (!candidates.length) return null;
    const artist = normName(ref.artist);
    const same = UNKNOWN.has(artist) ? candidates : candidates.filter((s) => normName(s.artist) === artist);
    if (same.length) return closest(same);
    return candidates.length === 1 ? candidates[0] : null;
  }
}

/**
 * Works out what restoring would do.
 * @returns {{playlists:[{name, ids, missing:[ref]}], liked:string[], likedMissing:[ref], found, missing, createdMs, from, settings}}
 */
export function planRestore(contents, songs) {
  const m = new SongMatcher(songs);
  const cache = new Map();
  const id = (r) => {
    const k = refKey(r);
    if (!cache.has(k)) { const s = m.find(r); cache.set(k, s ? s.id : null); }
    return cache.get(k);
  };
  const split = (refs) => {
    const ids = [];
    const missing = [];
    const seen = new Set();
    for (const r of refs) {
      const x = id(r);
      if (x) { if (!seen.has(x)) { seen.add(x); ids.push(x); } }
      else if (!missing.some((y) => refKey(y) === refKey(r))) missing.push(r);
    }
    return { ids, missing };
  };
  const playlists = contents.playlists.map((p) => ({ name: p.name, ...split(p.songs) }));
  const liked = split(contents.liked);
  // Count each song once, like Android does.
  const all = new Map();
  for (const r of [...contents.playlists.flatMap((p) => p.songs), ...contents.liked]) all.set(refKey(r), r);
  const found = [...all.values()].filter((r) => id(r)).length;
  return {
    createdMs: contents.createdMs,
    from: contents.from,
    settings: contents.settings,
    playlists,
    liked: liked.ids,
    likedMissing: liked.missing,
    found,
    missing: all.size - found,
  };
}

/**
 * Applies a plan to the app's data (returns new copies). Playlists with the same
 * name get the missing songs added; others are created. Songs not on this iPhone
 * are kept in `pending` (by playlist id), to add when you import them later.
 */
export function applyRestore(plan, { playlists, liked, pending }, makeId) {
  const lists = playlists.map((p) => ({ ...p, songs: p.songs.slice() }));
  const pend = clonePending(pending);
  for (const p of plan.playlists) {
    let target = lists.find((x) => x.name.trim().toLowerCase() === p.name.trim().toLowerCase());
    if (!target) {
      target = { id: makeId(), name: p.name, songs: [], created: Date.now() };
      lists.push(target);
    }
    for (const id of p.ids) if (!target.songs.includes(id)) target.songs.push(id);
    if (p.missing.length) pend.playlists[target.id] = mergeRefs(pend.playlists[target.id] || [], p.missing);
  }
  const likedOut = liked.slice();
  for (const id of plan.liked) if (!likedOut.includes(id)) likedOut.push(id);
  pend.liked = mergeRefs(pend.liked, plan.likedMissing);
  return { playlists: lists, liked: likedOut, pending: pend };
}

function mergeRefs(a, b) {
  const out = a.slice();
  for (const r of b) if (!out.some((x) => refKey(x) === refKey(r))) out.push(r);
  return out;
}

function clonePending(p) {
  return {
    playlists: { ...((p && p.playlists) || {}) },
    liked: ((p && p.liked) || []).slice(),
  };
}

/** How many different songs a restore is still waiting for. */
export function pendingCount(p) {
  if (!p) return 0;
  const all = [...Object.values(p.playlists || {}).flat(), ...(p.liked || [])];
  return new Set(all.map(refKey)).size;
}

/**
 * After songs are imported: puts any that a restore was waiting for into their
 * playlists and Liked songs. Returns null if nothing changed.
 */
export function resolvePending(pending, newSongs, { playlists, liked }) {
  if (!pendingCount(pending) || !newSongs.length) return null;
  const m = new SongMatcher(newSongs);
  const placed = new Set(); // song ids put back (counted once)
  const pend = clonePending(pending);
  const lists = playlists.map((p) => ({ ...p, songs: p.songs.slice() }));
  for (const [pid, refs] of Object.entries(pend.playlists)) {
    const target = lists.find((x) => x.id === pid);
    if (!target) { delete pend.playlists[pid]; continue; }
    const left = [];
    for (const r of refs) {
      const s = m.find(r);
      if (s) { if (!target.songs.includes(s.id)) { target.songs.push(s.id); placed.add(s.id); } }
      else left.push(r);
    }
    if (left.length) pend.playlists[pid] = left;
    else delete pend.playlists[pid];
  }
  const likedOut = liked.slice();
  pend.liked = pend.liked.filter((r) => {
    const s = m.find(r);
    if (!s) return true;
    if (!likedOut.includes(s.id)) { likedOut.push(s.id); placed.add(s.id); }
    return false;
  });
  return { playlists: lists, liked: likedOut, pending: pend, added: placed.size };
}
