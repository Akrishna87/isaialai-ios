import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../web/js/queue.js';

const ids = (s) => s.items.map((e) => e.id);
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test('plays in order and stops at the end with repeat off', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c'], 1);
  assert.equal(Q.current(s), 'b');
  s = Q.next(s, { auto: true });
  assert.equal(Q.current(s), 'c');
  assert.equal(Q.next(s, { auto: true }), null);
});

test('repeat all wraps, repeat one stays on auto but Next moves on', () => {
  let s = Q.cycleRepeat(Q.setQueue(Q.emptyQueue(), ['a', 'b'], 1));
  assert.equal(s.repeat, 'all');
  assert.equal(Q.current(Q.next(s, { auto: true })), 'a');
  s = Q.cycleRepeat(s);
  assert.equal(s.repeat, 'one');
  assert.equal(Q.current(Q.next(s, { auto: true })), 'b');
  assert.equal(Q.current(Q.next({ ...s, index: 0 }, { auto: false })), 'b');
  assert.equal(Q.cycleRepeat(s).repeat, 'off');
});

test('prev goes back, and wraps with repeat all', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c'], 0);
  assert.equal(Q.current(Q.prev(s)), 'a');
  s = { ...s, repeat: 'all' };
  assert.equal(Q.current(Q.prev(s)), 'c');
});

test('shuffle keeps the chosen song first and every song once', () => {
  const list = Array.from({ length: 50 }, (_, i) => 's' + i);
  const s = Q.setQueue(Q.emptyQueue(), list, 10, { shuffle: true, random: seeded(7) });
  assert.equal(Q.current(s), 's10');
  assert.equal(s.index, 0);
  assert.deepEqual([...ids(s)].sort(), [...list].sort());
  assert.notDeepEqual(ids(s), list);
});

test('turning shuffle off returns to the original order at the same song', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c', 'd', 'e'], 0);
  s = Q.next(s); // b
  s = Q.toggleShuffle(s, seeded(3));
  assert.equal(Q.current(s), 'b');
  assert.equal(s.index, 0);
  s = Q.next(s);
  const playing = Q.current(s);
  s = Q.toggleShuffle(s);
  assert.deepEqual(ids(s), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(Q.current(s), playing);
});

test('shuffleAll covers everything', () => {
  const s = Q.shuffleAll(Q.emptyQueue(), ['a', 'b', 'c', 'd'], seeded(5));
  assert.equal(s.shuffle, true);
  assert.deepEqual([...ids(s)].sort(), ['a', 'b', 'c', 'd']);
});

test('repeat all with shuffle reshuffles without repeating the last song', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c', 'd'], 0, { shuffle: true, random: seeded(2) });
  s = { ...s, repeat: 'all', index: 3 };
  const last = Q.current(s);
  for (let seed = 1; seed < 30; seed++) {
    const n = Q.next(s, { auto: true, random: seeded(seed) });
    assert.equal(n.index, 0);
    assert.notEqual(Q.current(n), last);
    assert.equal(n.items.length, 4);
  }
});

test('play next and add to queue', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c'], 0);
  s = Q.playNext(s, ['x']);
  assert.deepEqual(ids(s), ['a', 'x', 'b', 'c']);
  s = Q.addToQueue(s, ['y']);
  assert.deepEqual(ids(s), ['a', 'x', 'b', 'c', 'y']);
  assert.equal(Q.current(s), 'a');
  // Same song twice is fine: entries have their own keys.
  s = Q.addToQueue(s, ['a']);
  assert.equal(new Set(s.items.map((e) => e.k)).size, s.items.length);
  // Into an empty queue
  const e = Q.playNext(Q.emptyQueue(), ['z']);
  assert.equal(Q.current(e), 'z');
});

test('play next while shuffled survives turning shuffle off', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c', 'd'], 2, { shuffle: true, random: seeded(4) });
  s = Q.playNext(s, ['x']);
  assert.equal(ids(s)[1], 'x');
  s = Q.toggleShuffle(s);
  assert.deepEqual(ids(s), ['a', 'b', 'c', 'x', 'd']);
  assert.equal(Q.current(s), 'c');
});

test('remove and move keep the current song', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c', 'd'], 2);
  s = Q.removeAt(s, 0);
  assert.equal(Q.current(s), 'c');
  assert.deepEqual(ids(s), ['b', 'c', 'd']);
  s = Q.move(s, 2, 0);
  assert.deepEqual(ids(s), ['d', 'b', 'c']);
  assert.equal(Q.current(s), 'c');
  // Removing the current song moves on to the next one.
  s = Q.removeAt(s, 2);
  assert.equal(Q.current(s), 'b');
  s = Q.removeAt(Q.removeAt(s, 0), 0);
  assert.equal(s.index, -1);
  assert.equal(Q.current(s), null);
});

test('removeSongs drops deleted songs everywhere', () => {
  let s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'a', 'c'], 3);
  s = Q.removeSongs(s, new Set(['a']));
  assert.deepEqual(ids(s), ['b', 'c']);
  assert.deepEqual(s.original.map((e) => e.id), ['b', 'c']);
  assert.equal(Q.current(s), 'c');
});

test('upNext and sanitize', () => {
  const s = Q.setQueue(Q.emptyQueue(), ['a', 'b', 'c'], 1);
  assert.deepEqual(Q.upNext(s).map((e) => [e.id, e.pos]), [['c', 2]]);
  const back = Q.sanitize(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(back, s);
  assert.deepEqual(Q.sanitize(null), Q.emptyQueue());
  const bad = Q.sanitize({ items: [{ k: 1, id: 'a' }, 'junk'], index: 9, repeat: 'sometimes' });
  assert.equal(bad.index, 0);
  assert.equal(bad.repeat, 'off');
  assert.ok(bad.nextKey > 1);
});
