// Groups songs into albums, artists and music directors, and searches them.
// Pure functions, so they can be tested in Node.

import { splitNames } from './tags.js';

export const norm = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const byText = (a, b) => collator.compare(a, b);

export function albumKey(song) {
  return norm(song.album) + '|' + norm(song.albumArtist);
}

export function sortSongs(list) {
  return list.slice().sort((a, b) => byText(a.title, b.title));
}

export function sortAlbumTracks(list) {
  return list.slice().sort((a, b) => (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0) || byText(a.title, b.title));
}

function group(map, key, name, song) {
  let g = map.get(key);
  if (!g) map.set(key, (g = { key, name, songs: [] }));
  g.songs.push(song);
  return g;
}

export function buildIndex(songs) {
  const albums = new Map();
  const artists = new Map();
  const directors = new Map();
  for (const s of songs) {
    const a = group(albums, albumKey(s), s.album, s);
    a.artist = a.artist || s.albumArtist || s.composer || s.artist;
    a.year = Math.max(a.year || 0, s.year || 0);
    if (!a.art && s.art) a.art = s.art;
    for (const n of splitNames(s.artist)) group(artists, norm(n), n, s);
    for (const n of splitNames(s.composer)) group(directors, norm(n), n, s);
  }
  const finish = (m) => [...m.values()].sort((x, y) => byText(x.name, y.name));
  const withArt = (list) => {
    for (const g of list) g.art = g.art || (g.songs.find((s) => s.art) || {}).art || null;
    return list;
  };
  return {
    songs: sortSongs(songs),
    albums: finish(albums),
    artists: withArt(finish(artists)),
    directors: withArt(finish(directors)),
  };
}

// Albums inside a group of songs (a music director's movies), newest first.
export function albumsOf(songs) {
  const m = new Map();
  for (const s of songs) {
    const a = group(m, albumKey(s), s.album, s);
    a.year = Math.max(a.year || 0, s.year || 0);
    if (!a.art && s.art) a.art = s.art;
  }
  return [...m.values()].sort((x, y) => (y.year || 0) - (x.year || 0) || byText(x.name, y.name));
}

// Every word typed must appear somewhere in the text.
function matches(text, words) {
  return words.every((w) => text.includes(w));
}

export function search(index, query, limit = 50) {
  const q = norm(query);
  if (!q) return { songs: [], albums: [], artists: [], directors: [] };
  const words = q.split(' ');
  const rank = (name) => (norm(name).startsWith(q) ? 0 : 1);
  const songs = index.songs
    .filter((s) => matches(norm(`${s.title} ${s.artist} ${s.album} ${s.composer}`), words))
    .sort((a, b) => rank(a.title) - rank(b.title) || byText(a.title, b.title));
  const pick = (list) => list.filter((g) => matches(norm(g.name), words)).sort((a, b) => rank(a.name) - rank(b.name));
  return {
    songs: songs.slice(0, limit),
    moreSongs: Math.max(0, songs.length - limit),
    albums: pick(index.albums).slice(0, 20),
    artists: pick(index.artists).slice(0, 20),
    directors: pick(index.directors).slice(0, 20),
  };
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// A short, stable key for a picture's bytes, so a whole album shares one copy of its cover.
export function hashBytes(bytes) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619);
    h2 = Math.imul(h2 + bytes[i], 2246822519) ^ (h2 >>> 13);
  }
  return 'a' + bytes.length.toString(36) + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
