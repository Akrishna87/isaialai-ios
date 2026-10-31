import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { listZip, entryBlob, cleanPath, AUDIO_RE, BACKUP_RE, NotAZip } from '../web/js/zip.js';

const fx = async (n) => new Blob([await readFile(new URL('./fixtures/' + n, import.meta.url))]);

test('lists and unpacks an Android-style zip (deflate level 0, sizes after data)', async () => {
  const zip = await fx('android-songs.zip');
  const entries = await listZip(zip);
  assert.deepEqual(entries.map((e) => e.name), [
    'Music/Ilaiyaraaja/Ilaiyaraaja - Ilaya Nila.mp3', 'Music/Vaathi/tagged-v23.mp3', 'Download/tagged.m4a',
    'Pictures/not-a-song.txt', '../evil.mp3', 'Download/Isaialai/Isaialai backup.json',
  ]);
  for (const [i, file] of [[0, 'Ilaiyaraaja - Ilaya Nila.mp3'], [1, 'tagged-v23.mp3'], [2, 'tagged.m4a']]) {
    const want = new Uint8Array(await readFile(new URL('./fixtures/' + file, import.meta.url)));
    const got = new Uint8Array(await (await entryBlob(zip, entries[i], 'audio/mpeg')).arrayBuffer());
    assert.equal(got.length, want.length, file);
    assert.deepEqual(got, want, file);
  }
  const backup = await (await entryBlob(zip, entries[5])).text();
  assert.equal(JSON.parse(backup).app, 'Isaialai');
  assert.ok(BACKUP_RE.test(entries[5].name));
  assert.ok(AUDIO_RE.test(entries[2].name) && !AUDIO_RE.test(entries[3].name));
});

test('cleanPath refuses paths that escape', () => {
  assert.equal(cleanPath('../evil.mp3'), null);
  assert.equal(cleanPath('/Music//a/./b.mp3'), 'Music/a/b.mp3');
  assert.equal(cleanPath('Music\\Hindi\\x.mp3'), 'Music/Hindi/x.mp3');
  assert.equal(cleanPath(''), null);
});

test('not a zip', async () => {
  await assert.rejects(listZip(new Blob([new Uint8Array(100)])), NotAZip);
});

// A hand-made ZIP64 zip (as Java writes for big libraries): sizes and offset in the zip64 extra
// field, and a zip64 end record.
test('reads ZIP64', async () => {
  const data = new TextEncoder().encode('song bytes here');
  const name = new TextEncoder().encode('Music/a.mp3');
  const le = (n, len) => { const b = new Uint8Array(len); let v = BigInt(n); for (let i = 0; i < len; i++) { b[i] = Number(v & 255n); v >>= 8n; } return b; };
  const cat = (...a) => { const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
  const local = cat(le(0x04034b50, 4), le(45, 2), le(0, 2), le(0, 2), le(0, 4), le(0, 4), le(data.length, 4), le(data.length, 4), le(name.length, 2), le(0, 2), name, data);
  const extra = cat(le(1, 2), le(24, 2), le(data.length, 8), le(data.length, 8), le(0, 8));
  const central = cat(le(0x02014b50, 4), le(45, 2), le(45, 2), le(0, 2), le(0, 2), le(0, 4), le(0, 4),
    le(0xffffffff, 4), le(0xffffffff, 4), le(name.length, 2), le(extra.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(0xffffffff, 4), name, extra);
  const cdOff = local.length;
  const z64Off = cdOff + central.length;
  const z64 = cat(le(0x06064b50, 4), le(44, 8), le(45, 2), le(45, 2), le(0, 4), le(0, 4), le(1, 8), le(1, 8), le(central.length, 8), le(cdOff, 8));
  const loc = cat(le(0x07064b50, 4), le(0, 4), le(z64Off, 8), le(1, 4));
  const eocd = cat(le(0x06054b50, 4), le(0, 2), le(0, 2), le(0xffff, 2), le(0xffff, 2), le(0xffffffff, 4), le(0xffffffff, 4), le(0, 2));
  const zip = new Blob([cat(local, central, z64, loc, eocd)]);
  const [e] = await listZip(zip);
  assert.equal(e.name, 'Music/a.mp3');
  assert.equal(e.size, data.length);
  assert.equal(await (await entryBlob(zip, e)).text(), 'song bytes here');
});

// Made with java.util.zip.ZipOutputStream exactly as the Android app packs (see tests/fixtures/README).
test('reads a zip written by Java ZipOutputStream (Tamil folder name)', async () => {
  const zip = await fx('android-java.zip');
  const entries = await listZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['Music/இளையராஜா/Ilaiyaraaja - Ilaya Nila.mp3', 'Download/tagged.m4a', 'Download/Isaialai/Isaialai backup.json']);
  assert.ok(entries.every((e) => e.method === 8));
  const want = new Uint8Array(await readFile(new URL('./fixtures/tagged.m4a', import.meta.url)));
  assert.deepEqual(new Uint8Array(await (await entryBlob(zip, entries[1])).arrayBuffer()), want);
  assert.equal(JSON.parse(await (await entryBlob(zip, entries[2])).text()).app, 'Isaialai');
});
