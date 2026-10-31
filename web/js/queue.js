// The play queue, as plain data and pure functions (easy to test and to save).
//
// state = {
//   items:    [{k, id}]  the order songs play in (shuffled when shuffle is on)
//   original: [{k, id}]  the same entries in the order they were added
//   index:    position of the current song in items (-1 when empty)
//   shuffle:  boolean
//   repeat:   'off' | 'all' | 'one'
//   nextKey:  counter for entry keys (a song can be in the queue twice)
// }

export function emptyQueue() {
  return { items: [], original: [], index: -1, shuffle: false, repeat: 'off', nextKey: 1 };
}

function entries(state, ids) {
  let k = state.nextKey;
  const list = ids.map((id) => ({ k: k++, id }));
  return { list, nextKey: k };
}

export function shuffled(arr, random = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Starts a new queue. With shuffle on, the chosen song plays first and the rest are shuffled.
export function setQueue(state, ids, startIndex = 0, { shuffle = state.shuffle, random = Math.random } = {}) {
  if (!ids.length) return { ...emptyQueue(), repeat: state.repeat, shuffle, nextKey: state.nextKey };
  const { list, nextKey } = entries(state, ids);
  startIndex = Math.max(0, Math.min(startIndex, list.length - 1));
  let items = list;
  let index = startIndex;
  if (shuffle) {
    const first = list[startIndex];
    items = [first, ...shuffled(list.filter((e) => e !== first), random)];
    index = 0;
  }
  return { ...state, items, original: list, index, shuffle, nextKey };
}

// Shuffle everything, starting anywhere.
export function shuffleAll(state, ids, random = Math.random) {
  if (!ids.length) return setQueue(state, ids);
  const start = Math.floor(random() * ids.length);
  return setQueue(state, ids, start, { shuffle: true, random });
}

export function current(state) {
  const e = state.items[state.index];
  return e ? e.id : null;
}

export function currentEntry(state) {
  return state.items[state.index] || null;
}

// What plays after the current song ends (auto) or when Next is tapped (auto = false).
// Returns the new state, or null when playback should stop.
export function next(state, { auto = false, random = Math.random } = {}) {
  if (!state.items.length) return null;
  if (auto && state.repeat === 'one') return { ...state };
  if (state.index + 1 < state.items.length) return { ...state, index: state.index + 1 };
  if (state.repeat === 'off') return null;
  // Wrap around; reshuffle for a fresh order when shuffling.
  if (state.shuffle && state.items.length > 2) {
    const last = state.items[state.index];
    let items = shuffled(state.items, random);
    if (items[0] === last) items.push(items.shift()); // don't repeat the song we just heard
    return { ...state, items, index: 0 };
  }
  return { ...state, index: 0 };
}

export function prev(state) {
  if (!state.items.length) return null;
  if (state.index > 0) return { ...state, index: state.index - 1 };
  if (state.repeat === 'all') return { ...state, index: state.items.length - 1 };
  return { ...state, index: 0 };
}

export function jumpTo(state, i) {
  if (i < 0 || i >= state.items.length) return state;
  return { ...state, index: i };
}

export function toggleShuffle(state, random = Math.random) {
  const cur = currentEntry(state);
  if (!state.shuffle) {
    const rest = state.items.filter((e) => e !== cur);
    const items = cur ? [cur, ...shuffled(rest, random)] : shuffled(rest, random);
    return { ...state, shuffle: true, items, index: cur ? 0 : -1 };
  }
  const items = state.original.slice();
  const index = cur ? items.findIndex((e) => e.k === cur.k) : -1;
  return { ...state, shuffle: false, items, index };
}

export function cycleRepeat(state) {
  const order = ['off', 'all', 'one'];
  return { ...state, repeat: order[(order.indexOf(state.repeat) + 1) % order.length] };
}

// Inserts songs to play right after the current one.
export function playNext(state, ids) {
  const { list, nextKey } = entries(state, ids);
  if (!state.items.length) return { ...setQueue(state, ids, 0, { shuffle: false }), shuffle: state.shuffle };
  const cur = currentEntry(state);
  const items = state.items.slice();
  items.splice(state.index + 1, 0, ...list);
  const original = state.original.slice();
  const oi = cur ? original.findIndex((e) => e.k === cur.k) : original.length - 1;
  original.splice(oi + 1, 0, ...list);
  return { ...state, items, original, nextKey };
}

export function addToQueue(state, ids) {
  const { list, nextKey } = entries(state, ids);
  if (!state.items.length) return { ...setQueue(state, ids, 0, { shuffle: false }), shuffle: state.shuffle };
  return { ...state, items: [...state.items, ...list], original: [...state.original, ...list], nextKey };
}

// Removes the entry at position i of items. Removing the current song moves to the next one.
export function removeAt(state, i) {
  if (i < 0 || i >= state.items.length) return state;
  const gone = state.items[i];
  const items = state.items.filter((_, j) => j !== i);
  const original = state.original.filter((e) => e.k !== gone.k);
  let index = state.index;
  if (i < index) index--;
  else if (i === index && index >= items.length) index = items.length - 1;
  if (!items.length) index = -1;
  return { ...state, items, original, index };
}

export function move(state, from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.items.length || to >= state.items.length) return state;
  const items = state.items.slice();
  const [e] = items.splice(from, 1);
  items.splice(to, 0, e);
  const cur = currentEntry(state);
  const index = cur ? items.indexOf(cur) : state.index;
  // Keep the unshuffled order in step when not shuffling.
  const original = state.shuffle ? state.original : items.slice();
  return { ...state, items, original, index };
}

// Drops songs that were deleted from the library.
export function removeSongs(state, idSet) {
  let s = state;
  for (let i = s.items.length - 1; i >= 0; i--) if (idSet.has(s.items[i].id)) s = removeAt(s, i);
  return { ...s, original: s.original.filter((e) => !idSet.has(e.id)) };
}

export function upNext(state) {
  return state.items.slice(state.index + 1).map((e, n) => ({ ...e, pos: state.index + 1 + n }));
}

// Makes sure saved data still has the right shape.
export function sanitize(q) {
  const e = emptyQueue();
  if (!q || !Array.isArray(q.items)) return e;
  const ok = (x) => x && typeof x.k === 'number' && x.id != null;
  const items = q.items.filter(ok);
  const original = Array.isArray(q.original) ? q.original.filter(ok) : items.slice();
  const maxK = Math.max(0, ...items.map((x) => x.k), ...original.map((x) => x.k));
  return {
    items,
    original,
    index: items.length ? Math.max(0, Math.min(q.index | 0, items.length - 1)) : -1,
    shuffle: !!q.shuffle,
    repeat: ['off', 'all', 'one'].includes(q.repeat) ? q.repeat : 'off',
    nextKey: Math.max(maxK + 1, q.nextKey | 0),
  };
}
