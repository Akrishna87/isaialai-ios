// Reads song tags (title, artist, album, composer, year, track, cover art)
// from MP3 (ID3v2.2/2.3/2.4 and ID3v1) and M4A/MP4 (iTunes atoms).
// Works on anything with an async `read(offset, length) -> Uint8Array`
// and a `size`, so it runs in the browser (File/Blob) and in Node tests.

export function blobReader(blob) {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(blob.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

export function bytesReader(bytes) {
  return {
    size: bytes.length,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
  };
}

const MAX_TAG = 16 * 1024 * 1024;

export async function readTags(reader) {
  const head = await reader.read(0, 12);
  try {
    if (head.length >= 10 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const t = await readId3v2(reader, head);
      if (t.title || t.artist || t.album) return t;
      const v1 = await readId3v1(reader);
      return v1 ? { ...v1, ...strip(t) } : t;
    }
    if (head.length >= 8 && ascii(head, 4, 4) === 'ftyp') return await readMp4(reader);
    return (await readId3v1(reader)) || {};
  } catch (e) {
    return {};
  }
}

function strip(o) {
  const r = {};
  for (const k in o) if (o[k] !== undefined && o[k] !== '' && o[k] !== null) r[k] = o[k];
  return r;
}

function ascii(b, off, len) {
  let s = '';
  for (let i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u24 = (b, o) => (b[o] << 16) + (b[o + 1] << 8) + b[o + 2];
const u16 = (b, o) => (b[o] << 8) + b[o + 1];

function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeText(b, enc) {
  let label = 'latin1';
  if (enc === 1) label = 'utf-16';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  if (label === 'utf-16' && b.length >= 2) {
    // Honour the BOM; default to little-endian like most taggers.
    if (b[0] === 0xfe && b[1] === 0xff) { label = 'utf-16be'; b = b.subarray(2); }
    else if (b[0] === 0xff && b[1] === 0xfe) { label = 'utf-16le'; b = b.subarray(2); }
    else label = 'utf-16le';
  }
  let s = new TextDecoder(label).decode(b);
  return s;
}

// Text frames may hold several values separated by NUL (ID3v2.4).
function textValue(b, enc) {
  return decodeText(b, enc)
    .split('\u0000')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(', ');
}

function terminatorLength(enc) { return enc === 1 || enc === 2 ? 2 : 1; }

function findTerminator(b, from, enc) {
  if (terminatorLength(enc) === 1) {
    const i = b.indexOf(0, from);
    return i < 0 ? b.length : i;
  }
  for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  return b.length;
}

async function readId3v2(reader, head) {
  const major = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  if (major < 2 || major > 4 || size > MAX_TAG) return {};
  let tag = await reader.read(10, size);
  if (major < 4 && flags & 0x80) tag = unsync(tag);
  let pos = 0;
  if (flags & 0x40 && major >= 3) {
    // Extended header
    pos = major === 4 ? syncsafe(tag, 0) : u32(tag, 0) + 4;
  }
  const out = {};
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;
  while (pos + hdrLen <= tag.length) {
    const id = ascii(tag, pos, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fsize = major === 2 ? u24(tag, pos + 3) : major === 4 ? syncsafe(tag, pos + 4) : u32(tag, pos + 4);
    const fflags = major === 2 ? 0 : u16(tag, pos + 8);
    pos += hdrLen;
    if (fsize <= 0 || pos + fsize > tag.length) break;
    let data = tag.subarray(pos, pos + fsize);
    pos += fsize;
    if (major === 4) {
      if (fflags & 0x0001) data = data.subarray(4); // data length indicator
      if (fflags & 0x0002) data = unsync(data);
      if (fflags & 0x000c) continue; // compressed / encrypted: skip
    } else if (major === 3 && fflags & 0x00c0) continue;
    handleFrame(out, id, data, major);
  }
  return out;
}

const TEXT_FRAMES = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
  TCOM: 'composer', TCM: 'composer',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TYER: 'year', TYE: 'year', TDRC: 'year', TDOR: 'origYear', TORY: 'origYear',
  TRCK: 'track', TRK: 'track',
  TPOS: 'disc', TPA: 'disc',
  TCON: 'genre', TCO: 'genre',
  TLEN: 'lengthMs', TLE: 'lengthMs',
};

function handleFrame(out, id, data, major) {
  if (!data.length) return;
  const key = TEXT_FRAMES[id];
  if (key) {
    const v = textValue(data.subarray(1), data[0]);
    if (!v) return;
    if (key === 'year' || key === 'origYear') {
      const m = v.match(/\d{4}/);
      if (m && !out.year) out.year = parseInt(m[0], 10);
    } else if (key === 'track' || key === 'disc') {
      const n = parseInt(v, 10);
      if (n > 0) out[key] = n;
    } else if (key === 'lengthMs') {
      const n = parseInt(v, 10);
      if (n > 0) out.durationMs = n;
    } else if (!out[key]) out[key] = v;
    return;
  }
  if ((id === 'APIC' || id === 'PIC') && !out.picture) {
    const enc = data[0];
    let p = 1;
    let mime;
    if (id === 'PIC') {
      const fmt = ascii(data, 1, 3).toLowerCase();
      mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
      p = 4;
    } else {
      const end = data.indexOf(0, 1);
      if (end < 0) return;
      mime = ascii(data, 1, end - 1).toLowerCase() || 'image/jpeg';
      if (!mime.includes('/')) mime = 'image/' + (mime === 'png' ? 'png' : 'jpeg');
      p = end + 1;
    }
    const picType = data[p];
    p += 1;
    const dEnd = findTerminator(data, p, enc);
    p = dEnd + terminatorLength(enc);
    const bytes = data.slice(p);
    if (bytes.length > 16) out.picture = { mime: sniffImage(bytes) || mime, data: bytes, type: picType };
  }
}

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}

async function readId3v1(reader) {
  if (reader.size < 128) return null;
  const b = await reader.read(reader.size - 128, 128);
  if (ascii(b, 0, 3) !== 'TAG') return null;
  const field = (o, l) => {
    let e = o;
    while (e < o + l && b[e] !== 0) e++;
    return new TextDecoder('latin1').decode(b.subarray(o, e)).trim();
  };
  const out = strip({
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
  });
  const y = parseInt(field(93, 4), 10);
  if (y > 0) out.year = y;
  if (b[125] === 0 && b[126] !== 0) out.track = b[126];
  return out;
}

// ---- MP4 / M4A ----

const CONTAINERS = new Set(['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia']);

async function readMp4(reader) {
  // Walk top-level boxes to find moov (it may be at the start or the end).
  let pos = 0;
  while (pos + 8 <= reader.size) {
    const h = await reader.read(pos, 16);
    let size = u32(h, 0);
    const type = ascii(h, 4, 4);
    let hdr = 8;
    if (size === 1) { size = u32(h, 8) * 4294967296 + u32(h, 12); hdr = 16; }
    else if (size === 0) size = reader.size - pos;
    if (size < hdr) break;
    if (type === 'moov') {
      if (size > MAX_TAG * 4) return {};
      const moov = await reader.read(pos + hdr, size - hdr);
      const out = {};
      parseBoxes(moov, 0, moov.length, 'moov', out);
      return out;
    }
    pos += size;
  }
  return {};
}

function parseBoxes(b, start, end, parent, out) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(b, pos);
    const type = ascii(b, pos + 4, 4);
    let hdr = 8;
    if (size === 1) { size = u32(b, pos + 12); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr || pos + size > end) break;
    const cStart = pos + hdr;
    const cEnd = pos + size;
    if (type === 'mvhd') {
      const v = b[cStart];
      const scale = v === 1 ? u32(b, cStart + 20) : u32(b, cStart + 12);
      const dur = v === 1 ? u32(b, cStart + 24) * 4294967296 + u32(b, cStart + 28) : u32(b, cStart + 16);
      if (scale > 0) out.durationMs = Math.round((dur / scale) * 1000);
    } else if (type === 'meta') {
      // 'meta' is a full box (4 bytes version/flags) in iTunes files, but not in QuickTime ones.
      const skip = ascii(b, cStart + 4, 4) === 'hdlr' ? 0 : 4;
      parseBoxes(b, cStart + skip, cEnd, type, out);
    } else if (parent === 'ilst') {
      ilstItem(b, type, cStart, cEnd, out);
    } else if (CONTAINERS.has(type)) {
      parseBoxes(b, cStart, cEnd, type, out);
    }
    pos = cEnd;
  }
}

const ILST = {
  '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©wrt': 'composer',
  'aART': 'albumArtist', '©day': 'year', '©gen': 'genre',
};

function ilstItem(b, type, start, end, out) {
  // Find the 'data' child.
  let pos = start;
  while (pos + 16 <= end) {
    const size = u32(b, pos);
    if (size < 16 || pos + size > end) return;
    if (ascii(b, pos + 4, 4) === 'data') {
      const dataType = u24(b, pos + 9);
      const v = b.subarray(pos + 16, pos + size);
      if (type === 'covr') {
        if (!out.picture && v.length > 16) {
          out.picture = { mime: sniffImage(v) || (dataType === 14 ? 'image/png' : 'image/jpeg'), data: v.slice() };
        }
      } else if (type === 'trkn' || type === 'disk') {
        if (v.length >= 4) {
          const n = u16(v, 2);
          if (n > 0) out[type === 'trkn' ? 'track' : 'disc'] = n;
        }
      } else if (ILST[type]) {
        const key = ILST[type];
        const s = new TextDecoder('utf-8').decode(v).trim();
        if (!s) return;
        if (key === 'year') {
          const m = s.match(/\d{4}/);
          if (m) out.year = parseInt(m[0], 10);
        } else if (!out[key]) out[key] = s;
      }
      return;
    }
    pos += size;
  }
}

// ---- Fallbacks from the file name ----

export function tagsFromFileName(name) {
  let base = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/^\d{1,3}\s*[-.]\s*/, ''); // "01 - Song" / "01. Song"
  const parts = base.split(' - ');
  if (parts.length >= 2 && parts[0].trim() && parts.slice(1).join(' - ').trim()) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { title: base || 'Unknown song' };
}

// Final song fields from tags + file name.
export function songInfo(tags, fileName) {
  const fb = tagsFromFileName(fileName);
  const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  return {
    title: clean(tags.title) || fb.title,
    artist: clean(tags.artist) || clean(tags.albumArtist) || fb.artist || 'Unknown artist',
    album: clean(tags.album) || 'Unknown album',
    albumArtist: clean(tags.albumArtist),
    composer: clean(tags.composer),
    year: tags.year || 0,
    track: tags.track || 0,
    disc: tags.disc || 0,
    genre: clean(tags.genre),
    durationMs: tags.durationMs || 0,
  };
}

// Splits "A, B & C" into names, for artist and music director lists.
export function splitNames(s) {
  if (!s) return [];
  const seen = new Set();
  const out = [];
  for (let p of String(s).split(/\s*(?:,|;|\/|&|\bfeat\.?|\bft\.)\s*/i)) {
    p = p.trim();
    const k = p.toLowerCase();
    if (p && !seen.has(k)) { seen.add(k); out.push(p); }
  }
  return out;
}
