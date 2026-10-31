// Reads zip files straight from a Blob/File, one song at a time, so a zip of
// several GB never has to fit in memory. Handles what the Android app's
// "Pack all songs into a zip" writes (Java ZipOutputStream: deflate with no
// compression, sizes after each file, ZIP64 for big zips), plus ordinary
// stored/deflated zips from computers.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296;

async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

export class NotAZip extends Error {
  constructor() { super('Not a zip file'); this.name = 'NotAZip'; }
}

/** Lists the files in a zip: [{name, size, compSize, method, offset, encrypted}]. */
export async function listZip(blob) {
  const tailStart = Math.max(0, blob.size - (65535 + 22));
  const tail = await bytes(blob, tailStart, blob.size);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { e = i; break; }
  }
  if (e < 0) throw new NotAZip();
  let count = u16(tail, e + 10);
  let cdSize = u32(tail, e + 12);
  let cdOffset = u32(tail, e + 16);
  // ZIP64: the real numbers are in the zip64 end record, found through the locator just before.
  const locAt = e - 20;
  if (locAt >= 0 && u32(tail, locAt) === 0x07064b50) {
    const z64At = u64(tail, locAt + 8);
    const z = await bytes(blob, z64At, z64At + 56);
    if (u32(z, 0) === 0x06064b50) {
      count = u64(z, 32);
      cdSize = u64(z, 40);
      cdOffset = u64(z, 48);
    }
  }
  if (cdOffset + cdSize > blob.size) throw new NotAZip();
  const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
  const out = [];
  const utf8 = new TextDecoder('utf-8');
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field: only the values that didn't fit, in this order.
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); q += 8; }
      }
      x += 4 + len;
    }
    out.push({ name, size, compSize, method, offset, encrypted: !!(flags & 1), dir: name.endsWith('/') });
    p = xEnd + commentLen;
  }
  return out;
}

/** The file's contents as a Blob (stored files are a slice of the zip: no copying). */
export async function entryBlob(blob, entry, type = '') {
  const h = await bytes(blob, entry.offset, entry.offset + 30);
  if (u32(h, 0) !== 0x04034b50) throw new Error('Damaged zip');
  const start = entry.offset + 30 + u16(h, 26) + u16(h, 28);
  const raw = blob.slice(start, start + entry.compSize, type);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This iPhone is too old to unpack zips (needs iOS 16.4 or newer).');
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const out = await new Response(stream).blob();
    return type ? new Blob([out], { type }) : out;
  }
  throw new Error('Unsupported zip compression');
}

/**
 * A safe relative path from an entry name, or null (no "..", no absolute paths),
 * like the Android app's MusicZip.clean.
 */
export function cleanPath(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').map((s) => s.trim()).filter((s) => s && s !== '.');
  if (!parts.length || parts.length > 24 || parts.some((s) => s === '..' || s.length > 200 || /[\u0000-\u001f]/.test(s))) return null;
  return parts.join('/');
}

export const AUDIO_RE = /\.(mp3|m4a|m4b|aac|mp4|wav|flac|ogg|opus|aif|aiff)$/i;
export const BACKUP_RE = /(^|\/)Isaialai backup\.json$/i;
