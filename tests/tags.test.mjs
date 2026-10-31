import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readTags, bytesReader, songInfo, tagsFromFileName, splitNames } from '../web/js/tags.js';

const fx = async (name) => new Uint8Array(await readFile(new URL('./fixtures/' + name, import.meta.url)));
const tags = async (name) => readTags(bytesReader(await fx(name)));

function checkCommon(t) {
  assert.equal(t.title, 'Vaa Vaathi');
  assert.equal(t.artist, 'Shweta Mohan, G. V. Prakash');
  assert.equal(t.album, 'வாத்தி (Vaathi)');
  assert.equal(t.composer, 'G. V. Prakash Kumar');
  assert.equal(t.year, 2023);
  assert.equal(t.track, 3);
}

test('ID3v2.3 mp3 (UTF-16) with cover art', async () => {
  const t = await tags('tagged-v23.mp3');
  checkCommon(t);
  assert.equal(t.picture.mime, 'image/jpeg');
  assert.equal(t.picture.data[0], 0xff);
  assert.equal(t.picture.data[1], 0xd8);
});

test('ID3v2.4 mp3 (UTF-8)', async () => {
  const t = await tags('tagged-v24.mp3');
  checkCommon(t);
  assert.equal(t.picture, undefined);
});

test('m4a with moov at the start, and cover', async () => {
  const t = await tags('tagged.m4a');
  checkCommon(t);
  assert.ok(t.durationMs > 1900 && t.durationMs < 2200, 'duration ' + t.durationMs);
  assert.equal(t.picture.mime, 'image/jpeg');
});

test('m4a with moov at the end', async () => {
  const t = await tags('tagged-moov-end.m4a');
  checkCommon(t);
});

test('untagged mp3 falls back to the file name', async () => {
  const t = await tags('Ilaiyaraaja - Ilaya Nila.mp3');
  const s = songInfo(t, 'Ilaiyaraaja - Ilaya Nila.mp3');
  assert.equal(s.title, 'Ilaya Nila');
  assert.equal(s.artist, 'Ilaiyaraaja');
  assert.equal(s.album, 'Unknown album');
});

// Hand-built tags for the cases ffmpeg doesn't write.
function frame23(id, payload) {
  const b = new Uint8Array(10 + payload.length);
  b.set([...id].map((c) => c.charCodeAt(0)), 0);
  const n = payload.length;
  b.set([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255], 4);
  b.set(payload, 10);
  return b;
}
function frame22(id, payload) {
  const b = new Uint8Array(6 + payload.length);
  b.set([...id].map((c) => c.charCodeAt(0)), 0);
  const n = payload.length;
  b.set([(n >> 16) & 255, (n >> 8) & 255, n & 255], 3);
  b.set(payload, 6);
  return b;
}
function tag(major, frames, flags = 0) {
  const body = new Uint8Array(frames.reduce((n, f) => n + f.length, 0) + 20); // + padding
  let o = 0;
  for (const f of frames) { body.set(f, o); o += f.length; }
  const n = body.length;
  const h = new Uint8Array([0x49, 0x44, 0x33, major, 0, flags, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const out = new Uint8Array(10 + n + 100);
  out.set(h); out.set(body, 10);
  return out;
}
const latin = (s) => new Uint8Array([0, ...[...s].map((c) => c.charCodeAt(0))]);
const utf16be = (s) => { const a = [2]; for (const c of s) { const x = c.charCodeAt(0); a.push(x >> 8, x & 255); } return new Uint8Array(a); };

test('ID3v2.2 frames', async () => {
  const b = tag(2, [frame22('TT2', latin('Song')), frame22('TP1', latin('Singer')), frame22('TAL', latin('Movie')), frame22('TCM', latin('Ilaiyaraaja')), frame22('TYE', latin('1985'))]);
  const t = await readTags(bytesReader(b));
  assert.deepEqual([t.title, t.artist, t.album, t.composer, t.year], ['Song', 'Singer', 'Movie', 'Ilaiyaraaja', 1985]);
});

test('ID3v2.3 UTF-16BE without BOM, and APIC with description', async () => {
  const jpeg = new Uint8Array(40).fill(7); jpeg[0] = 0xff; jpeg[1] = 0xd8;
  const apic = new Uint8Array([0, ...[...'image/jpeg'].map((c) => c.charCodeAt(0)), 0, 3, ...[...'front'].map((c) => c.charCodeAt(0)), 0, ...jpeg]);
  const b = tag(3, [frame23('TIT2', utf16be('பாடல்')), frame23('APIC', apic)]);
  const t = await readTags(bytesReader(b));
  assert.equal(t.title, 'பாடல்');
  assert.equal(t.picture.data.length, 40);
  assert.equal(t.picture.type, 3);
});

test('ID3v1 only', async () => {
  const b = new Uint8Array(500);
  const v1 = b.subarray(500 - 128);
  const put = (o, s) => [...s].forEach((c, i) => (v1[o + i] = c.charCodeAt(0)));
  put(0, 'TAG'); put(3, 'Old Song'); put(33, 'Old Singer'); put(63, 'Old Album'); put(93, '1979');
  v1[125] = 0; v1[126] = 4;
  const t = await readTags(bytesReader(b));
  assert.deepEqual([t.title, t.artist, t.album, t.year, t.track], ['Old Song', 'Old Singer', 'Old Album', 1979, 4]);
});

test('garbage does not throw', async () => {
  assert.deepEqual(await readTags(bytesReader(new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 127, 127, 127, 127]))), {});
  assert.deepEqual(await readTags(bytesReader(new Uint8Array(5))), {});
});

test('file name fallbacks', () => {
  assert.deepEqual(tagsFromFileName('01 - Kannalane.mp3'), { title: 'Kannalane' });
  assert.deepEqual(tagsFromFileName('A.R. Rahman - Uyire.m4a'), { artist: 'A.R. Rahman', title: 'Uyire' });
  assert.deepEqual(tagsFromFileName('my_song_name.mp3'), { title: 'my song name' });
});

test('splitNames', () => {
  assert.deepEqual(splitNames('S. P. Balasubrahmanyam, K. S. Chithra'), ['S. P. Balasubrahmanyam', 'K. S. Chithra']);
  assert.deepEqual(splitNames('Anirudh & Dhanush feat. Someone'), ['Anirudh', 'Dhanush', 'Someone']);
  assert.deepEqual(splitNames('Shankar-Ehsaan-Loy'), ['Shankar-Ehsaan-Loy']);
  assert.deepEqual(splitNames(''), []);
});
