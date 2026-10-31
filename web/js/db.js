// Storage: song details and settings in IndexedDB, the song files themselves
// in the Origin Private File System (OPFS) when the browser allows writing
// there, otherwise as Blobs in IndexedDB.

const DB_NAME = 'isaialai';
const DB_VERSION = 1;
let dbp;

function req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('art')) db.createObjectStore('art');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => (out = v));
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transaction aborted'));
  });
}

export const kv = {
  async get(key, fallback = null) {
    const v = await tx('kv', 'readonly', (s) => req(s.get(key)));
    return v === undefined ? fallback : v;
  },
  set(key, value) {
    return tx('kv', 'readwrite', (s) => { s.put(value, key); });
  },
};

export function allSongs() {
  return tx('songs', 'readonly', (s) => req(s.getAll()));
}

export function putSong(song) {
  return tx('songs', 'readwrite', (s) => { s.put(song); });
}

export function getArt(id) {
  return tx('art', 'readonly', (s) => req(s.get(id)));
}

export function putArt(id, blob) {
  return tx('art', 'readwrite', (s) => { s.put(blob, id); });
}

// ---- Song files ----

let opfsOk;
async function opfsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('songs', { create: true });
}

// True if the page can write files to OPFS (newer Safari can; older ones only from workers).
export async function canUseOpfs() {
  if (opfsOk !== undefined) return opfsOk;
  opfsOk = false;
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return false;
    const dir = await opfsDir();
    const h = await dir.getFileHandle('.probe', { create: true });
    if (typeof h.createWritable !== 'function') return false;
    const w = await h.createWritable();
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();
    const f = await h.getFile();
    opfsOk = f.size === 3;
    await dir.removeEntry('.probe').catch(() => {});
  } catch (e) {
    opfsOk = false;
  }
  return opfsOk;
}

// Saves the file and returns where it went: 'opfs' or 'idb'.
export async function saveFile(id, file) {
  if (await canUseOpfs()) {
    try {
      const dir = await opfsDir();
      const h = await dir.getFileHandle(id, { create: true });
      const w = await h.createWritable();
      await w.write(file);
      await w.close();
      return 'opfs';
    } catch (e) {
      try { (await opfsDir()).removeEntry(id); } catch (_) {}
      if (e && e.name === 'QuotaExceededError') throw e;
    }
  }
  // Copy into memory first: Safari can't store a File that points at a picked document.
  const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/mpeg' });
  await tx('files', 'readwrite', (s) => { s.put(blob, id); });
  return 'idb';
}

export async function getFile(song) {
  if (song.store === 'opfs') {
    const dir = await opfsDir();
    const h = await dir.getFileHandle(song.id);
    const f = await h.getFile();
    // Give it the right type so Safari knows how to play it.
    return f.type ? f : new Blob([f], { type: song.type || 'audio/mpeg' });
  }
  return tx('files', 'readonly', (s) => req(s.get(song.id)));
}

// Removes the song and its file. Cover art is shared, so the caller removes unused art.
export async function deleteSong(song) {
  if (song.store === 'opfs') {
    try { await (await opfsDir()).removeEntry(song.id); } catch (e) {}
  }
  const db = await open();
  await new Promise((res, rej) => {
    const t = db.transaction(['songs', 'files', 'art'], 'readwrite');
    t.objectStore('songs').delete(song.id);
    t.objectStore('files').delete(song.id);
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
  });
}

export function deleteArt(key) {
  return tx('art', 'readwrite', (s) => { s.delete(key); });
}

export async function storageInfo() {
  const out = { usage: 0, quota: 0, persisted: false };
  try {
    if (navigator.storage && navigator.storage.estimate) Object.assign(out, await navigator.storage.estimate());
    if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
  } catch (e) {}
  return out;
}

export async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (e) {}
  return false;
}
