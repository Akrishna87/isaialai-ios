import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search, albumsOf, formatTime, formatBytes, hashBytes } from '../web/js/library.js';

const song = (id, o) => ({ id, title: id, artist: 'X', album: 'A', albumArtist: '', composer: '', year: 0, ...o });
const songs = [
  song('Kannalane', { artist: 'K. S. Chithra', album: 'Bombay', composer: 'A. R. Rahman', year: 1995, art: 'art1' }),
  song('Uyire', { artist: 'Hariharan, K. S. Chithra', album: 'Bombay', composer: 'A. R. Rahman', year: 1995 }),
  song('Ilaya Nila', { artist: 'S. P. Balasubrahmanyam', album: 'Payanangal Mudivathillai', composer: 'Ilaiyaraaja', year: 1982 }),
  song('வா வாத்தி', { artist: 'Shweta Mohan', album: 'Vaathi', composer: 'G. V. Prakash Kumar', year: 2023 }),
];

test('groups albums, artists and music directors', () => {
  const ix = buildIndex(songs);
  assert.deepEqual(ix.albums.map((a) => a.name), ['Bombay', 'Payanangal Mudivathillai', 'Vaathi']);
  const bombay = ix.albums[0];
  assert.equal(bombay.songs.length, 2);
  assert.equal(bombay.art, 'art1');
  assert.equal(bombay.year, 1995);
  const chithra = ix.artists.find((a) => a.name === 'K. S. Chithra');
  assert.equal(chithra.songs.length, 2);
  assert.deepEqual(ix.directors.map((d) => d.name), ['A. R. Rahman', 'G. V. Prakash Kumar', 'Ilaiyaraaja']);
});

test('albumsOf sorts newest first', () => {
  assert.deepEqual(albumsOf(songs).map((a) => a.name), ['Vaathi', 'Bombay', 'Payanangal Mudivathillai']);
});

test('search matches words anywhere, and Tamil text', () => {
  const ix = buildIndex(songs);
  assert.deepEqual(search(ix, 'chithra bombay').songs.map((s) => s.id).sort(), ['Kannalane', 'Uyire']);
  assert.deepEqual(search(ix, 'rahman').directors.map((d) => d.name), ['A. R. Rahman']);
  assert.deepEqual(search(ix, 'வாத்தி').songs.map((s) => s.id), ['வா வாத்தி']);
  assert.deepEqual(search(ix, 'ILAYA').songs.map((s) => s.id), ['Ilaya Nila']);
  assert.equal(search(ix, '   ').songs.length, 0);
});

test('formatting', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65.9), '1:05');
  assert.equal(formatTime(3725), '1:02:05');
  assert.equal(formatTime(NaN), '0:00');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.50 GB');
});

test('hashBytes is stable and differs for different pictures', () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  assert.equal(hashBytes(a), hashBytes(new Uint8Array([1, 2, 3, 4])));
  assert.notEqual(hashBytes(a), hashBytes(new Uint8Array([1, 2, 3, 5])));
});
