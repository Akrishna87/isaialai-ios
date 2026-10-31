import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, parseBackup, planRestore, applyRestore, resolvePending, pendingCount, SongMatcher } from '../web/js/backup.js';

const song = (id, o) => ({ id, title: id, artist: 'X', album: 'A', durationMs: 200000, fileName: id + '.mp3', ...o });

// Shaped like a real backup from the Android app (BackupFile.write).
const android = JSON.stringify({
  app: 'Isaialai', format: 1, created: '2026-10-01T10:00:00+0530', createdMs: 1790000000000,
  playlists: [{ name: 'Road trip', songs: [0, 1, 2] }, { name: 'Raja hits', songs: [3] }],
  liked: [1, 4], history: [0], plays: [{ song: 0, count: 5, last: 1 }], edits: [], settings: { ui: { theme: 'dark' } },
  listens: [[1, 0, 30000]],
  songs: [
    { path: '/storage/emulated/0/Music/Bombay/Kannalane.mp3', title: 'Kannalane', artist: 'K. S. Chithra', album: 'Bombay', durationMs: 330000 },
    { path: '/storage/emulated/0/Download/Uyire.mp3', title: 'Uyire', artist: 'Hariharan', album: 'Bombay', durationMs: 400000 },
    { path: '/storage/1234-ABCD/Songs/not-here.mp3', title: 'Not here', artist: 'Someone', album: 'B', durationMs: 100000 },
    { path: '/storage/emulated/0/WhatsApp/renamed-file.mp3', title: 'Ilaya Nila', artist: 'S. P. Balasubrahmanyam', album: 'P', durationMs: 280000 },
    { path: '/storage/emulated/0/Music/later.mp3', title: 'Later', artist: 'L', album: 'L', durationMs: 150000 },
  ],
});

const phone = [
  song('k', { fileName: 'Kannalane.mp3', title: 'Kannalane', artist: 'K. S. Chithra', durationMs: 331000 }),
  song('u', { fileName: 'UYIRE.mp3', title: 'Uyire', durationMs: 399500 }),
  song('i', { fileName: 'ilaya_nila.mp3', title: 'Ilaya Nila', artist: 'S.P. Balasubrahmanyam', durationMs: 281000 }),
];

test('reads an Android backup', () => {
  const c = parseBackup(android);
  assert.equal(c.from, 'Android');
  assert.equal(c.playlists.length, 2);
  assert.equal(c.playlists[0].songs[0].title, 'Kannalane');
  assert.equal(c.liked.length, 2);
  assert.equal(c.settings, null);
  assert.equal(parseBackup('{"app":"Other"}'), null);
  assert.equal(parseBackup('not json'), null);
  assert.ok(parseBackup('\uFEFF' + android));
});

test('matches songs by file name, then by title and artist', () => {
  const m = new SongMatcher(phone);
  const c = parseBackup(android);
  const refs = c.playlists[0].songs;
  assert.equal(m.find(refs[0]).id, 'k'); // same file name
  assert.equal(m.find(refs[1]).id, 'u'); // file name differs only in case
  assert.equal(m.find(refs[2]), null);
  assert.equal(m.find(c.playlists[1].songs[0]).id, 'i'); // different file name, same title, artist punctuation differs
  // Same file name but a very different length isn't the same song.
  assert.equal(m.find({ path: '/x/Kannalane.mp3', title: 'Other', artist: '', durationMs: 100000 }), null);
});

test('plan and apply a restore, keeping missing songs for later', () => {
  const plan = planRestore(parseBackup(android), phone);
  assert.equal(plan.found, 3);
  assert.equal(plan.missing, 2);
  let n = 0;
  const existing = [{ id: 'p0', name: 'road trip', songs: ['u'], created: 1 }];
  const r = applyRestore(plan, { playlists: existing, liked: ['k'], pending: null }, () => 'new' + n++);
  assert.equal(r.playlists.length, 2);
  assert.deepEqual(r.playlists[0].songs, ['u', 'k']); // merged into the playlist with the same name
  assert.deepEqual(r.playlists[1], { ...r.playlists[1], id: 'new0', name: 'Raja hits', songs: ['i'] });
  assert.deepEqual(r.liked, ['k', 'u']);
  assert.equal(pendingCount(r.pending), 2); // 'Not here' and 'Later'
  assert.equal(existing[0].songs.length, 1, 'input not changed');

  // Later the missing songs are imported.
  const added = [song('n', { fileName: 'not-here.mp3', title: 'Not here', durationMs: 100500 }), song('l', { fileName: 'later.mp3', title: 'Later', durationMs: 150000 })];
  const after = resolvePending(r.pending, added, r);
  assert.equal(after.added, 2);
  assert.deepEqual(after.playlists[0].songs, ['u', 'k', 'n']);
  assert.deepEqual(after.liked, ['k', 'u', 'l']);
  assert.equal(pendingCount(after.pending), 0);
  assert.equal(resolvePending(after.pending, added, after), null);
});

test('an iPhone backup round-trips, including songs still waiting to be added', () => {
  const playlists = [{ id: 'p1', name: 'Mine', songs: ['k', 'i', 'gone'] }];
  const pending = { playlists: { p1: [{ path: '/storage/emulated/0/x.mp3', title: 'X song', artist: 'Y', album: '', durationMs: 1 }] }, liked: [] };
  const text = makeBackup({ songs: phone, playlists, liked: ['u'], settings: { lockButtons: 'seek' }, now: 1790000000000, pending });
  const o = JSON.parse(text);
  assert.equal(o.app, 'Isaialai');
  assert.equal(o.format, 1);
  assert.deepEqual(Object.keys(o).at(-1), 'songs');
  assert.equal(o.songs[0].path, '/Kannalane.mp3');
  assert.match(o.created, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d{4}$/);
  const c = parseBackup(text);
  assert.equal(c.from, 'iPhone');
  assert.deepEqual(c.settings, { lockButtons: 'seek' });
  assert.equal(c.playlists[0].songs.length, 3); // k, i and the pending one ('gone' isn't in the library)
  const plan = planRestore(c, phone);
  assert.deepEqual(plan.playlists[0].ids, ['k', 'i']);
  assert.equal(plan.playlists[0].missing[0].title, 'X song');
  assert.deepEqual(plan.liked, ['u']);
});
