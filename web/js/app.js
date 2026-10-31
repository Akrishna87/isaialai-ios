import * as db from './db.js';
import { readTags, blobReader, songInfo } from './tags.js';
import * as L from './library.js';
import { Player } from './player.js';
import * as Q from './queue.js';
import * as B from './backup.js';
import * as Z from './zip.js';

const VERSION = '1.2.0';
const $ = (id) => document.getElementById(id);

// ---------- State ----------

const S = {
  songs: new Map(),
  index: L.buildIndex([]),
  playlists: [], // [{id, name, songs: [id], created}]
  liked: [], // song ids, newest first
  likedSet: new Set(),
  settings: { lockButtons: 'tracks' },
  tab: 'library',
  libSub: 'songs',
  stack: [], // views pushed on top of the current tab
  query: '',
  importing: false,
  pending: null, // songs from a restored backup that aren't on this iPhone yet
  lastBackup: 0,
};

const artUrls = new Map(); // art key -> object URL

// ---------- Small DOM helper ----------

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style') e.style.cssText = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
}

const ICON = {
  play: '<svg viewBox="0 0 24 24" class="fill"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" class="fill"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
  heartOn: '<svg viewBox="0 0 24 24" class="fill heart-on"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
  more: '<svg viewBox="0 0 24 24" class="fill"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3"/></svg>',
  repeatOne: '<svg viewBox="0 0 24 24"><path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3"/><text x="12" y="14.6" text-anchor="middle" font-size="7" stroke="none" fill="currentColor" font-weight="800">1</text></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M3 7h3.5c2 0 3 1 4.2 2.8l2.6 4.4C14.5 16 15.5 17 17.5 17H21M3 17h3.5c1.4 0 2.3-.5 3.1-1.4M13.4 8.4c.8-.9 1.7-1.4 3.1-1.4H21M18 4l3 3-3 3M18 14l3 3-3 3"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4M6 11H5v10h14V11h-1"/></svg>',
  addBox: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
};

// ---------- Toast ----------

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- Art ----------

async function artUrl(key) {
  if (!key) return null;
  if (artUrls.has(key)) return artUrls.get(key);
  const p = db.getArt(key).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
  artUrls.set(key, p);
  return p;
}

const artObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        artObserver.unobserve(e.target);
        loadArt(e.target);
      }
    }, { rootMargin: '400px' })
  : null;

async function loadArt(node) {
  const url = await artUrl(node.dataset.art);
  if (url) {
    node.style.backgroundImage = `url("${url}")`;
    node.classList.add('has');
  }
}

function thumb(key, cls = '') {
  const d = el('div', { class: 'thumb ' + cls, 'aria-hidden': 'true' });
  if (key) {
    d.dataset.art = key;
    if (artObserver) artObserver.observe(d);
    else loadArt(d);
  }
  return d;
}

async function setImg(img, key) {
  const url = await artUrl(key);
  if (url) {
    img.src = url;
    img.classList.remove('empty');
  } else {
    img.removeAttribute('src');
    img.classList.add('empty');
  }
}

// ---------- Loading and saving the library ----------

async function loadAll() {
  const songs = await db.allSongs();
  S.songs = new Map(songs.map((s) => [s.id, s]));
  S.playlists = (await db.kv.get('playlists', [])) || [];
  S.liked = ((await db.kv.get('liked', [])) || []).filter((id) => S.songs.has(id));
  S.likedSet = new Set(S.liked);
  S.settings = { ...S.settings, ...((await db.kv.get('settings', {})) || {}) };
  S.pending = await db.kv.get('pending', null);
  S.lastBackup = (await db.kv.get('lastBackup', 0)) || 0;
  reindex();
}

function reindex() {
  S.index = L.buildIndex([...S.songs.values()]);
}

const savePlaylists = () => db.kv.set('playlists', S.playlists);
const saveLiked = () => db.kv.set('liked', S.liked);
const saveSettings = () => db.kv.set('settings', S.settings);
const savePending = () => db.kv.set('pending', S.pending);

// ---------- Player ----------

const player = new Player($('audio'), {
  song: (id) => S.songs.get(id),
  fileUrl: async (song) => {
    const blob = await db.getFile(song);
    if (!blob) throw new Error('Song file missing');
    return URL.createObjectURL(blob);
  },
  artwork: (song) => {
    const abs = (u) => new URL(u, location.href).href;
    if (song.art && navigator.serviceWorker && navigator.serviceWorker.controller) {
      return [{ src: abs('art/' + song.art), sizes: '512x512' }];
    }
    return [{ src: abs('icons/icon-512.png'), sizes: '512x512', type: 'image/png' }];
  },
  load: () => db.kv.get('player', null),
  save: (v) => db.kv.set('player', v).catch(() => {}),
  setDuration: (song, ms) => {
    song.durationMs = ms;
    db.putSong(song).catch(() => {});
  },
  settings: () => S.settings,
});

player.addEventListener('message', (e) => toast(e.detail));
player.addEventListener('remote', () => { if (currentView().type === 'settings') render(); });
player.addEventListener('song', () => renderNowPlaying());
player.addEventListener('state', () => renderPlayState());
player.addEventListener('time', () => renderTime());
player.addEventListener('queue', () => {
  renderModes();
  if (sheetKind === 'queue') renderQueueSheet();
});

// ---------- Navigation ----------

const TAB_TITLES = { library: 'Library', search: 'Search', playlists: 'Playlists', settings: 'Settings' };

function go(view) {
  S.stack.push(view);
  render(true);
}

function back() {
  if (S.stack.length) {
    S.stack.pop();
    render(true);
  }
}

function setTab(tab) {
  if (S.tab === tab && !S.stack.length) {
    $('view').scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  S.tab = tab;
  S.stack = [];
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  render(true);
}

let renderedKey = '';
function render(resetScroll = false) {
  const view = S.stack[S.stack.length - 1] || { type: S.tab };
  const main = $('view');
  const key = JSON.stringify(view) + S.libSub;
  const keepScroll = !resetScroll && key === renderedKey ? main.scrollTop : 0;
  renderedKey = key;
  $('backBtn').hidden = !S.stack.length;
  $('importBtn').hidden = !(view.type === 'library' || view.type === 'settings');
  main.replaceChildren();
  const r = VIEWS[view.type] || VIEWS.library;
  const title = r(main, view);
  $('title').textContent = title || TAB_TITLES[S.tab];
  document.title = (title || TAB_TITLES[S.tab]) + ' · Isaialai';
  main.scrollTop = keepScroll;
}

// ---------- Rows ----------

function songRow(song, { list, index, context } = {}) {
  const cur = Q.current(player.q) === song.id;
  const row = el(
    'div',
    { class: 'row song' + (cur ? ' current' : ''), role: 'button', tabindex: '0', 'data-id': song.id },
    thumb(song.art),
    el('div', { class: 'row-text' },
      el('div', { class: 't1' }, song.title),
      el('div', { class: 't2' }, [song.artist, song.album].filter(Boolean).join(' · '))),
    el('button', { class: 'icon-btn row-more', 'aria-label': 'More for ' + song.title, html: ICON.more,
      onclick: (e) => { e.stopPropagation(); songMenu(song, context); } }),
  );
  const play = () => {
    if (list) player.playList(list.map((s) => s.id), index);
    else player.playList([song.id], 0);
  };
  row.addEventListener('click', play);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });
  return row;
}

// Renders long lists in chunks, so thousands of songs stay quick.
function songList(parent, songs, opts = {}) {
  const box = el('div', { class: 'list' });
  parent.append(box);
  let i = 0;
  const CHUNK = 120;
  const more = () => {
    const end = Math.min(songs.length, i + CHUNK);
    const frag = document.createDocumentFragment();
    for (; i < end; i++) frag.append(songRow(songs[i], { list: songs, index: i, context: opts.context }));
    box.append(frag);
    if (i < songs.length) {
      const sentinel = el('div', { class: 'sentinel' });
      box.append(sentinel);
      const io = new IntersectionObserver((es) => {
        if (es.some((e) => e.isIntersecting)) { io.disconnect(); sentinel.remove(); more(); }
      }, { rootMargin: '800px' });
      io.observe(sentinel);
    }
  };
  more();
  return box;
}

function groupRow(g, sub, onclick, round = false) {
  return el('div', { class: 'row', role: 'button', tabindex: '0', onclick },
    thumb(g.art, round ? 'round' : ''),
    el('div', { class: 'row-text' }, el('div', { class: 't1' }, g.name), el('div', { class: 't2' }, sub)),
  );
}

function tile(g, sub, onclick) {
  return el('div', { class: 'tile', role: 'button', tabindex: '0', onclick },
    thumb(g.art, 'big'),
    el('div', { class: 't1' }, g.name),
    el('div', { class: 't2' }, sub));
}

const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function actionBar(songs, extra = []) {
  const ids = songs.map((s) => s.id);
  return el('div', { class: 'actions' },
    el('button', { class: 'btn primary', disabled: !ids.length ? true : null, onclick: () => player.playList(ids, 0, { shuffle: false }) },
      el('span', { html: ICON.play }), 'Play'),
    el('button', { class: 'btn', disabled: !ids.length ? true : null, onclick: () => player.shuffleAll(ids) },
      el('span', { html: ICON.shuffle }), 'Shuffle'),
    ...extra);
}

function header(title, sub, art, round = false) {
  return el('div', { class: 'hero' },
    thumb(art, 'hero-art' + (round ? ' round' : '')),
    el('div', { class: 'hero-text' }, el('h2', null, title), sub ? el('div', { class: 't2' }, sub) : null));
}

function empty(msg, withImport = false) {
  return el('div', { class: 'empty' },
    el('div', { class: 'empty-wave', 'aria-hidden': 'true' }),
    el('p', null, msg),
    withImport ? el('button', { class: 'btn primary', onclick: pickFiles }, el('span', { html: ICON.plus }), 'Add songs') : null);
}

// ---------- Views ----------

const VIEWS = {
  library(main) {
    const subs = [['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['directors', 'Music directors']];
    main.append(el('div', { class: 'chips' },
      subs.map(([k, label]) => el('button', { class: 'chip' + (S.libSub === k ? ' on' : ''), onclick: () => { S.libSub = k; render(true); } }, label))));
    if (!S.songs.size) {
      main.append(empty('No songs yet. Tap Add songs and pick mp3 or m4a files from the Files app (On My iPhone, iCloud Drive, or files you AirDropped), or the zip from Isaialai on Android.', true));
      return 'Library';
    }
    const ix = S.index;
    if (S.libSub === 'songs') {
      main.append(actionBar(ix.songs), el('div', { class: 'count' }, count(ix.songs.length, 'song')));
      songList(main, ix.songs);
    } else if (S.libSub === 'albums') {
      main.append(el('div', { class: 'grid' }, ix.albums.map((a) =>
        tile(a, [a.year || '', a.artist].filter(Boolean).join(' · ') || count(a.songs.length, 'song'), () => go({ type: 'album', key: a.key })))));
    } else if (S.libSub === 'artists') {
      main.append(el('div', { class: 'list' }, ix.artists.map((a) => groupRow(a, count(a.songs.length, 'song'), () => go({ type: 'artist', key: a.key }), true))));
    } else {
      if (!ix.directors.length) main.append(empty("No music directors found. They come from the songs' Composer tag."));
      main.append(el('div', { class: 'list' }, ix.directors.map((d) =>
        groupRow(d, `${count(L.albumsOf(d.songs).length, 'movie')} · ${count(d.songs.length, 'song')}`, () => go({ type: 'director', key: d.key }), true))));
    }
    return 'Library';
  },

  album(main, v) {
    const a = S.index.albums.find((x) => x.key === v.key);
    if (!a) return gone(main);
    const songs = L.sortAlbumTracks(a.songs);
    main.append(header(a.name, [a.artist, a.year || ''].filter(Boolean).join(' · '), a.art),
      actionBar(songs, [el('button', { class: 'icon-btn', 'aria-label': 'More', html: ICON.more, onclick: () => groupMenu(a.name, songs) })]));
    songList(main, songs);
    return a.name;
  },

  artist(main, v) {
    const a = S.index.artists.find((x) => x.key === v.key);
    if (!a) return gone(main);
    const songs = L.sortSongs(a.songs);
    main.append(header(a.name, count(songs.length, 'song'), a.art, true), actionBar(songs));
    albumStrip(main, a.songs);
    main.append(el('h3', { class: 'section' }, 'Songs'));
    songList(main, songs);
    return a.name;
  },

  director(main, v) {
    const d = S.index.directors.find((x) => x.key === v.key);
    if (!d) return gone(main);
    const albums = L.albumsOf(d.songs);
    main.append(header(d.name, `Music director · ${count(albums.length, 'movie')}`, d.art, true), actionBar(L.sortSongs(d.songs)));
    albumStrip(main, d.songs);
    main.append(el('h3', { class: 'section' }, 'Songs'));
    songList(main, L.sortSongs(d.songs));
    return d.name;
  },

  search(main) {
    const input = el('input', { type: 'search', class: 'search', placeholder: 'Songs, artists, movies, music directors', value: S.query,
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    const results = el('div');
    main.append(el('div', { class: 'search-wrap' }, input), results);
    const run = () => {
      S.query = input.value;
      results.replaceChildren();
      if (!S.query.trim()) {
        results.append(el('p', { class: 'hint' }, S.songs.size ? 'Type to search your songs.' : 'Add some songs first, from the Library tab.'));
        return;
      }
      const r = L.search(S.index, S.query);
      const none = !r.songs.length && !r.albums.length && !r.artists.length && !r.directors.length;
      if (none) results.append(el('p', { class: 'hint' }, `Nothing found for “${S.query.trim()}”.`));
      if (r.directors.length) {
        results.append(el('h3', { class: 'section' }, 'Music directors'));
        results.append(el('div', { class: 'list' }, r.directors.map((d) => groupRow(d, 'Music director', () => go({ type: 'director', key: d.key }), true))));
      }
      if (r.artists.length) {
        results.append(el('h3', { class: 'section' }, 'Artists'));
        results.append(el('div', { class: 'list' }, r.artists.slice(0, 8).map((a) => groupRow(a, count(a.songs.length, 'song'), () => go({ type: 'artist', key: a.key }), true))));
      }
      if (r.albums.length) {
        results.append(el('h3', { class: 'section' }, 'Albums'));
        results.append(el('div', { class: 'list' }, r.albums.slice(0, 8).map((a) => groupRow(a, [a.year || '', a.artist].filter(Boolean).join(' · '), () => go({ type: 'album', key: a.key })))));
      }
      if (r.songs.length) {
        results.append(el('h3', { class: 'section' }, 'Songs'));
        songList(results, r.songs);
        if (r.moreSongs) results.append(el('p', { class: 'hint' }, `and ${r.moreSongs} more. Type more to narrow it down.`));
      }
    };
    input.addEventListener('input', run);
    run();
    if (!S.query) setTimeout(() => input.focus({ preventScroll: true }), 50);
    return 'Search';
  },

  playlists(main) {
    main.append(el('div', { class: 'list' },
      el('div', { class: 'row', role: 'button', tabindex: '0', onclick: () => go({ type: 'liked' }) },
        el('div', { class: 'thumb liked-thumb', html: ICON.heartOn }),
        el('div', { class: 'row-text' }, el('div', { class: 't1' }, 'Liked songs'), el('div', { class: 't2' }, count(S.liked.length, 'song')))),
      el('div', { class: 'row', role: 'button', tabindex: '0', onclick: () => newPlaylist() },
        el('div', { class: 'thumb add-thumb', html: ICON.plus }),
        el('div', { class: 'row-text' }, el('div', { class: 't1' }, 'New playlist'))),
      S.playlists.map((p) => {
        const first = p.songs.map((id) => S.songs.get(id)).find((s) => s && s.art);
        return groupRow({ name: p.name, art: first && first.art }, count(p.songs.filter((id) => S.songs.has(id)).length, 'song'), () => go({ type: 'playlist', id: p.id }));
      })));
    return 'Playlists';
  },

  liked(main) {
    const songs = S.liked.map((id) => S.songs.get(id)).filter(Boolean);
    main.append(el('div', { class: 'hero' }, el('div', { class: 'thumb hero-art liked-thumb', html: ICON.heartOn }),
      el('div', { class: 'hero-text' }, el('h2', null, 'Liked songs'), el('div', { class: 't2' }, count(songs.length, 'song')))));
    main.append(actionBar(songs));
    if (!songs.length) main.append(empty('Tap ♡ in the player, or Like in a song’s ⋯ menu, and it shows up here.'));
    songList(main, songs, { context: { liked: true } });
    return 'Liked songs';
  },

  playlist(main, v) {
    const p = S.playlists.find((x) => x.id === v.id);
    if (!p) return gone(main);
    const songs = p.songs.map((id) => S.songs.get(id)).filter(Boolean);
    const first = songs.find((s) => s.art);
    main.append(header(p.name, count(songs.length, 'song'), first && first.art));
    main.append(actionBar(songs, [el('button', { class: 'icon-btn', 'aria-label': 'Playlist options', html: ICON.more, onclick: () => playlistMenu(p) })]));
    if (!songs.length) main.append(empty('Empty for now. Use a song’s ⋯ menu → Add to playlist.'));
    songList(main, songs, { context: { playlist: p.id } });
    return p.name;
  },

  settings(main) {
    const box = el('div', { class: 'settings' });
    main.append(box);
    const total = [...S.songs.values()].reduce((n, s) => n + (s.size || 0), 0);
    const store = el('div', { class: 'card' },
      el('h3', null, 'Storage'),
      el('p', null, `${count(S.songs.size, 'song')} · ${L.formatBytes(total)}`),
      el('p', { class: 't2', id: 'storeLine' }, 'Checking…'));
    box.append(store);
    db.storageInfo().then((i) => {
      const line = $('storeLine');
      if (!line) return;
      line.textContent = (i.quota ? `This app is using ${L.formatBytes(i.usage)} of the ${L.formatBytes(i.quota)} it may use. ` : '') +
        (i.persisted ? 'Songs are kept safe: iPhone won’t clear them to free up space.' : 'iPhone may clear the songs if the phone runs very low on space and you haven’t opened the app in a while.');
      if (!i.persisted) {
        line.after(el('button', { class: 'btn', onclick: async () => { const ok = await db.askPersist(); toast(ok ? 'Done: your songs are kept safe.' : 'iPhone said not yet. Adding the app to the Home Screen and using it helps.'); render(); } }, 'Keep my songs safe'));
      }
    });
    store.append(el('div', { class: 'card-actions' },
      el('button', { class: 'btn primary', onclick: pickFiles }, el('span', { html: ICON.plus }), 'Add songs'),
      S.songs.size ? el('button', { class: 'btn danger', onclick: deleteAllSongs }, 'Delete all songs') : null));

    const waiting = B.pendingCount(S.pending);
    const days = S.lastBackup ? Math.floor((Date.now() - S.lastBackup) / 86400000) : -1;
    box.append(el('div', { class: 'card' },
      el('h3', null, 'Backup & restore'),
      el('p', { class: 't2' }, 'Saves your playlists and Liked songs to a file (not the songs themselves). If you delete the app, restore it from this file. Works with backups from Isaialai on Android too.'),
      el('p', { class: 't2' }, 'Moving from Android? There, use Pack all songs into a zip. Here, tap + and pick the zip: the songs and your playlists come across together.'),
      el('p', { class: 't2' }, days < 0 ? 'No backup yet.' : `Last backup: ${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}.`),
      waiting ? el('p', { class: 't2' }, `${count(waiting, 'song')} from a backup will go back into your playlists and likes when you add them.`) : null,
      el('div', { class: 'card-actions' },
        el('button', { class: 'btn primary', onclick: backUp }, 'Back up now'),
        el('button', { class: 'btn', onclick: pickBackup }, 'Restore'),
        waiting ? el('button', { class: 'btn ghost', onclick: async () => {
          if (!confirm('Forget the songs a backup is still waiting for?')) return;
          S.pending = null; await savePending(); render();
        } }, 'Forget waiting songs') : null)));

    const choice = (val, label, desc) => el('label', { class: 'radio' },
      el('input', { type: 'radio', name: 'lock', value: val, checked: S.settings.lockButtons === val ? true : null,
        onchange: () => { S.settings.lockButtons = val; saveSettings(); player.setActions(); toast('Lock screen buttons changed'); } }),
      el('span', null, el('b', null, label), el('br'), el('span', { class: 't2' }, desc)));
    box.append(el('div', { class: 'card' },
      el('h3', null, 'Lock screen buttons'),
      el('p', { class: 't2' }, 'iPhone shows either song buttons or 10-second buttons on the lock screen, not both.'),
      choice('tracks', '⏮ ⏭ Previous / next song', 'Best for most people.'),
      choice('seek', '⏪ ⏩ Back / forward 10 seconds', 'Handy for long songs and stories. Change songs in the app.')));

    const r = player.lastRemote;
    const names = { play: 'Play', pause: 'Pause', stop: 'Stop', previoustrack: 'Previous song', nexttrack: 'Next song',
      seekto: 'Seek bar', seekbackward: 'Back 10 s', seekforward: 'Forward 10 s' };
    box.append(el('div', { class: 'card' },
      el('h3', null, 'Lock screen check'),
      el('p', { class: 't2', id: 'remoteLine' }, !('mediaSession' in navigator)
        ? 'This browser has no lock-screen controls for web apps.'
        : r ? `Last button from the lock screen: ${names[r.action] || r.action}, at ${new Date(r.at).toLocaleTimeString()}.`
          : 'No lock-screen button presses yet. Play a song, lock the phone, press a button, then come back here.'),
      el('p', { class: 't2' }, navigator.serviceWorker && navigator.serviceWorker.controller
        ? 'Cover art for the lock screen: ready.'
        : 'Cover art for the lock screen: not ready yet. Close and reopen the app once.')));

    box.append(el('div', { class: 'card' },
      el('h3', null, 'Good to know'),
      el('ul', { class: 'notes' },
        el('li', null, 'iPhone doesn’t let web apps see your music library, so Isaialai keeps its own copy of the songs you add. You can delete the originals from Files afterwards if you like.'),
        el('li', null, 'Volume, equaliser, crossfade and fade-out aren’t possible on iPhone web apps. Use the phone’s volume buttons.'),
        el('li', null, 'AirPlay: open Control Centre, tap the AirPlay icon on the music card.'),
        el('li', null, 'Songs added in Safari and in the Home Screen app are kept separately. Use the Home Screen app.'))));

    box.append(el('div', { class: 'card about' },
      el('h3', null, 'Isaialai (இசையலை) for iPhone'),
      el('p', { class: 't2' }, `Version ${VERSION} · Isaialai means “music wave” in Tamil. No ads, no account; your songs never leave your phone.`),
      el('button', { class: 'btn', onclick: showInstall }, 'How to install')));
    return 'Settings';
  },
};

function gone(main) {
  main.append(empty('This isn’t here any more.'));
  return '';
}

function albumStrip(main, songs) {
  const albums = L.albumsOf(songs);
  if (albums.length < 2) return;
  main.append(el('h3', { class: 'section' }, 'Movies & albums'),
    el('div', { class: 'strip' }, albums.map((a) => tile(a, a.year || count(a.songs.length, 'song'), () => go({ type: 'album', key: a.key })))));
}

// ---------- Sheets (menus) ----------

let sheetKind = null;
function openSheet(kind, build) {
  sheetKind = kind;
  const body = $('sheetBody');
  body.replaceChildren();
  build(body);
  $('sheet').hidden = false;
  requestAnimationFrame(() => $('sheet').classList.add('open'));
}

function closeSheet() {
  sheetKind = null;
  const s = $('sheet');
  s.classList.remove('open');
  setTimeout(() => { if (!sheetKind) s.hidden = true; }, 220);
}

function item(label, onclick, cls = '') {
  return el('button', { class: 'sheet-item ' + cls, onclick: () => { closeSheet(); onclick(); } }, label);
}

function sheetHead(title, sub, art) {
  return el('div', { class: 'sheet-head' }, art !== undefined ? thumb(art) : null,
    el('div', { class: 'row-text' }, el('div', { class: 't1' }, title), sub ? el('div', { class: 't2' }, sub) : null));
}

function songMenu(song, context = {}) {
  const liked = S.likedSet.has(song.id);
  const album = S.index.albums.find((a) => a.key === L.albumKey(song));
  openSheet('song', (b) => {
    b.append(sheetHead(song.title, [song.artist, song.album].filter(Boolean).join(' · '), song.art || null));
    b.append(
      item('Play next', () => { player.playNext([song.id]); toast('Playing next'); }),
      item('Add to queue', () => { player.addToQueue([song.id]); toast('Added to queue'); }),
      item(liked ? 'Unlike' : 'Like', () => toggleLike(song.id)),
      item('Add to playlist…', () => addToPlaylistSheet([song.id])),
      context.playlist ? item('Remove from this playlist', () => removeFromPlaylist(context.playlist, song.id)) : null,
      album ? item('Go to album', () => goFromPlayer({ type: 'album', key: album.key })) : null,
      ...L.buildIndex([song]).artists.map((a) => item(`Go to ${a.name}`, () => goFromPlayer({ type: 'artist', key: a.key }))),
      ...L.buildIndex([song]).directors.map((d) => item(`Music director: ${d.name}`, () => goFromPlayer({ type: 'director', key: d.key }))),
      item('Song details', () => detailsSheet(song)),
      item('Delete from Isaialai', () => confirmDelete([song], `Delete “${song.title}”?`), 'danger'),
    );
  });
}

function groupMenu(name, songs) {
  openSheet('group', (b) => {
    b.append(sheetHead(name, count(songs.length, 'song')));
    b.append(
      item('Play next', () => { player.playNext(songs.map((s) => s.id)); toast('Playing next'); }),
      item('Add to queue', () => { player.addToQueue(songs.map((s) => s.id)); toast('Added to queue'); }),
      item('Add to playlist…', () => addToPlaylistSheet(songs.map((s) => s.id))),
      item(`Delete these ${count(songs.length, 'song')}`, () => confirmDelete(songs, `Delete ${count(songs.length, 'song')} from “${name}”?`), 'danger'),
    );
  });
}

function detailsSheet(song) {
  const rows = [
    ['Title', song.title], ['Artist', song.artist], ['Album', song.album], ['Music director', song.composer],
    ['Year', song.year || ''], ['Track', song.track || ''], ['Length', song.durationMs ? L.formatTime(song.durationMs / 1000) : ''],
    ['File', song.fileName], ['Size', L.formatBytes(song.size)], ['Added', new Date(song.addedAt).toLocaleDateString()],
  ].filter((r) => r[1]);
  openSheet('details', (b) => {
    b.append(sheetHead('Song details'));
    b.append(el('dl', { class: 'details' }, rows.map(([k, v]) => [el('dt', null, k), el('dd', null, String(v))])));
  });
}

function playlistMenu(p) {
  openSheet('playlist', (b) => {
    b.append(sheetHead(p.name));
    b.append(
      item('Rename', () => {
        const name = prompt('Playlist name', p.name);
        if (name && name.trim()) { p.name = name.trim(); savePlaylists(); render(); }
      }),
      item('Add to queue', () => { player.addToQueue(p.songs.filter((id) => S.songs.has(id))); toast('Added to queue'); }),
      item('Delete playlist', () => {
        if (!confirm(`Delete the playlist “${p.name}”? The songs stay in your library.`)) return;
        S.playlists = S.playlists.filter((x) => x.id !== p.id);
        savePlaylists();
        back();
        toast('Playlist deleted');
      }, 'danger'),
    );
  });
}

function addToPlaylistSheet(ids) {
  openSheet('addto', (b) => {
    b.append(sheetHead('Add to playlist'));
    b.append(item('＋ New playlist', () => newPlaylist(ids)));
    b.append(item('♥ Liked songs', () => { for (const id of ids) like(id, true); toast('Added to Liked songs'); }));
    for (const p of S.playlists) {
      b.append(item(p.name, () => {
        const add = ids.filter((id) => !p.songs.includes(id));
        p.songs.push(...add);
        savePlaylists();
        toast(add.length ? `Added to ${p.name}` : `Already in ${p.name}`);
        if (currentView().type === 'playlist') render();
      }));
    }
  });
}

function newPlaylist(ids = []) {
  const name = prompt('Name your playlist', `My playlist ${S.playlists.length + 1}`);
  if (!name || !name.trim()) return;
  const p = { id: uid(), name: name.trim(), songs: [...new Set(ids)], created: Date.now() };
  S.playlists.push(p);
  savePlaylists();
  toast(ids.length ? `Added to ${p.name}` : `Created ${p.name}`);
  if (S.tab === 'playlists' || currentView().type === 'playlist') render();
}

function removeFromPlaylist(pid, id) {
  const p = S.playlists.find((x) => x.id === pid);
  if (!p) return;
  const i = p.songs.indexOf(id);
  if (i >= 0) p.songs.splice(i, 1);
  savePlaylists();
  render();
  toast('Removed from playlist');
}

function currentView() {
  return S.stack[S.stack.length - 1] || { type: S.tab };
}

function goFromPlayer(view) {
  closePlayer();
  go(view);
}

// ---------- Likes ----------

function like(id, on) {
  const has = S.likedSet.has(id);
  if (on === has) return;
  if (on) { S.liked.unshift(id); S.likedSet.add(id); }
  else { S.liked = S.liked.filter((x) => x !== id); S.likedSet.delete(id); }
  saveLiked();
  renderLike();
  if (currentView().type === 'liked' || (S.tab === 'playlists' && !S.stack.length)) render();
}

function toggleLike(id) {
  const on = !S.likedSet.has(id);
  like(id, on);
  toast(on ? 'Added to Liked songs' : 'Removed from Liked songs', 1500);
}

// ---------- Delete ----------

async function confirmDelete(songs, msg) {
  if (!confirm(`${msg}\n\nThis removes ${songs.length === 1 ? 'it' : 'them'} from Isaialai on this iPhone. Your original files in the Files app aren’t touched.`)) return;
  await deleteSongs(songs);
}

async function deleteAllSongs() {
  if (!confirm(`Delete all ${count(S.songs.size, 'song')} from Isaialai? Playlists will be empty. Your original files in the Files app aren’t touched.`)) return;
  await deleteSongs([...S.songs.values()]);
}

async function deleteSongs(songs) {
  const ids = new Set(songs.map((s) => s.id));
  player.removeSongs(ids);
  for (const s of songs) {
    await db.deleteSong(s).catch(() => {});
    S.songs.delete(s.id);
  }
  // Remove cover art nothing uses any more.
  const used = new Set([...S.songs.values()].map((s) => s.art).filter(Boolean));
  for (const key of new Set(songs.map((s) => s.art).filter(Boolean))) {
    if (!used.has(key)) {
      await db.deleteArt(key).catch(() => {});
      const u = artUrls.get(key);
      artUrls.delete(key);
      if (u) u.then((x) => x && URL.revokeObjectURL(x));
    }
  }
  S.liked = S.liked.filter((id) => !ids.has(id));
  S.likedSet = new Set(S.liked);
  for (const p of S.playlists) p.songs = p.songs.filter((id) => !ids.has(id));
  await Promise.all([saveLiked(), savePlaylists()]);
  reindex();
  render();
  toast(`Deleted ${count(songs.length, 'song')}`);
}

// ---------- Import ----------

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function pickFiles() {
  if (S.importing) return toast('Still adding songs…');
  const input = $('fileInput');
  input.value = '';
  input.click();
}

function probeDuration(file) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      a.removeAttribute('src');
      try { a.load(); } catch (e) {}
      URL.revokeObjectURL(url);
      res(v);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
    a.onerror = () => finish(-1);
    setTimeout(() => finish(0), 6000);
    a.src = url;
  });
}

const AUDIO_EXT = /\.(mp3|m4a|aac|mp4|m4b|wav|flac|ogg|opus)$/i;

const isZip = (f) => /\.zip$/i.test(f.name) || /zip/.test(f.type || '');

function mimeFor(name) {
  return /\.(m4a|m4b|mp4|aac)$/i.test(name) ? 'audio/mp4' : /\.wav$/i.test(name) ? 'audio/wav' : 'audio/mpeg';
}

// Keeps the screen on while adding songs: iPhone pauses web apps when the screen locks.
async function keepAwake() {
  try {
    if (navigator.wakeLock) return await navigator.wakeLock.request('screen');
  } catch (e) {}
  return null;
}

// Songs picked in Files, and zips (like the Android app's "Pack all songs into a zip").
async function importFiles(files) {
  if (S.importing) return toast('Still adding songs…');
  const items = [];
  const backups = [];
  let unreadable = 0;
  for (const f of files) {
    if (isZip(f)) {
      toast(`Opening ${f.name}…`, 0);
      let entries;
      try {
        entries = await Z.listZip(f);
      } catch (e) {
        console.error(e);
        unreadable++;
        continue;
      }
      for (const e of entries) {
        if (e.dir || e.encrypted || (e.method !== 0 && e.method !== 8)) continue;
        const path = Z.cleanPath(e.name);
        if (!path) continue;
        if (Z.BACKUP_RE.test(path) && e.size < 20 * 1024 * 1024) {
          backups.push(Z.entryBlob(f, e).then((b) => b.text()).catch(() => null));
        } else if (Z.AUDIO_RE.test(path)) {
          const name = path.split('/').pop();
          items.push({ name, size: e.size, path, type: mimeFor(name), get: () => Z.entryBlob(f, e, mimeFor(name)) });
        }
      }
    } else if (AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/')) {
      items.push({ name: f.name, size: f.size, path: '', type: f.type || mimeFor(f.name), get: async () => f });
    }
  }
  const backupTexts = (await Promise.all(backups)).filter(Boolean);
  if (!items.length && !backupTexts.length) {
    return toast(unreadable ? 'Couldn’t open that zip.' : 'Those weren’t songs. Pick mp3 or m4a files, or a zip of songs.', 5000);
  }
  await importItems(items);
  // The zip came with the Android app's backup: offer to bring back playlists and likes.
  for (const text of backupTexts) await restoreText(text, 'zip');
}

async function importItems(files) {
  if (!files.length) return;
  S.importing = true;
  db.askPersist();
  const lock = await keepAwake();
  const existing = new Set([...S.songs.values()].map((s) => s.fileName + '|' + s.size));
  let added = 0;
  let skipped = 0;
  let failed = 0;
  const newSongs = [];
  try {
    for (let n = 0; n < files.length; n++) {
      const f = files[n];
      toast(`Adding songs… ${n + 1} of ${files.length}${files.length > 20 ? '. Keep the app open.' : ''}`, 0);
      if (existing.has(f.name + '|' + f.size)) { skipped++; continue; }
      try {
        const blob = await f.get();
        const tags = await readTags(blobReader(blob));
        const info = songInfo(tags, f.name);
        const id = uid();
        let art = null;
        if (tags.picture && tags.picture.data.length) {
          art = L.hashBytes(tags.picture.data);
          if (!(await db.getArt(art))) await db.putArt(art, new Blob([tags.picture.data], { type: tags.picture.mime }));
        }
        if (!info.durationMs) {
          const d = await probeDuration(blob);
          if (d < 0) { failed++; continue; } // the phone can't play it
          info.durationMs = d;
        }
        const store = await db.saveFile(id, blob);
        const song = {
          id, ...info, art, fileName: f.name, path: f.path || '', size: f.size,
          type: f.type || mimeFor(f.name),
          store, addedAt: Date.now(),
        };
        await db.putSong(song);
        S.songs.set(id, song);
        newSongs.push(song);
        existing.add(f.name + '|' + f.size);
        added++;
        if (added % 25 === 0) { reindex(); render(); }
  } catch (e) {
        if (e && e.name === 'QuotaExceededError') {
          toast('Your iPhone is out of space for more songs.', 6000);
          break;
        }
        console.error('Import failed', f.name, e);
        failed++;
      }
    }
  } finally {
    S.importing = false;
    if (lock) lock.release().catch(() => {});
    reindex();
    render();
  }
  const parts = added || !skipped ? [`Added ${count(added, 'song')}`] : ['Already in your library'];
  if (skipped && added) parts.push(`${skipped} already here`);
  if (failed) parts.push(`${failed} couldn’t be read`);
  const back = B.resolvePending(S.pending, newSongs, { playlists: S.playlists, liked: S.liked });
  if (back) {
    S.playlists = back.playlists;
    S.liked = back.liked;
    S.likedSet = new Set(S.liked);
    S.pending = B.pendingCount(back.pending) ? back.pending : null;
    await Promise.all([savePlaylists(), saveLiked(), savePending()]);
    if (back.added) parts.push(`${count(back.added, 'song')} put back in your playlists`);
    render();
  }
  toast(parts.join(' · '), 5000);
}

// ---------- Backup and restore ----------

function backupText() {
  return B.makeBackup({
    songs: S.songs, playlists: S.playlists, liked: S.liked, pending: S.pending,
    settings: { lockButtons: S.settings.lockButtons },
  });
}

// Saves the backup with the Share sheet (→ Save to Files), or as a download.
async function backUp() {
  const text = backupText();
  const file = new File([text], B.BACKUP_NAME, { type: 'application/json' });
  let saved = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      saved = true;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // closed the Share sheet
    }
  }
  if (!saved) {
    const url = URL.createObjectURL(file);
    const a = el('a', { href: url, download: B.BACKUP_NAME });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    saved = true;
  }
  S.lastBackup = Date.now();
  await db.kv.set('lastBackup', S.lastBackup);
  if (currentView().type === 'settings') render();
  toast('Backup made. Keep it somewhere safe, like iCloud Drive.', 4000);
}

function pickBackup() {
  const input = $('backupInput');
  input.value = '';
  input.click();
}

async function restoreFrom(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    return toast('Couldn’t read that file.');
  }
  return restoreText(text, 'file');
}

async function restoreText(text, from) {
  const contents = B.parseBackup(text);
  if (!contents) {
    if (from === 'file') toast('That isn’t an Isaialai backup. Pick the file called “Isaialai backup.json”.', 5000);
    return;
  }
  const plan = B.planRestore(contents, [...S.songs.values()]);
  const when = contents.createdMs ? new Date(contents.createdMs).toLocaleString() : 'unknown date';
  const total = plan.found + plan.missing;
  const lines = [
    from === 'zip' ? 'The zip also has your playlists and Liked songs.' : '',
    `Backup from ${contents.from === 'iPhone' ? 'an iPhone' : 'the Android app'}, made ${when}.`,
    '',
    `${count(plan.playlists.length, 'playlist')} and ${count(contents.liked.length, 'liked song')}.`,
    total ? `${plan.found} of ${count(total, 'song')} are already in Isaialai on this iPhone.` : '',
    plan.missing ? `The other ${plan.missing} will be put back automatically when you add those songs.` : '',
    '',
    'Your current playlists and likes are kept; playlists with the same name get the songs added.',
    '',
    'Restore now?',
  ].filter((x, i, a) => x !== '' || (i > 0 && a[i - 1] !== ''));
  if (!confirm(lines.join('\n'))) return;
  const r = B.applyRestore(plan, { playlists: S.playlists, liked: S.liked, pending: S.pending }, uid);
  S.playlists = r.playlists;
  S.liked = r.liked;
  S.likedSet = new Set(S.liked);
  S.pending = B.pendingCount(r.pending) ? r.pending : null;
  if (plan.settings && ['tracks', 'seek'].includes(plan.settings.lockButtons)) {
    S.settings.lockButtons = plan.settings.lockButtons;
    await saveSettings();
    player.setActions();
  }
  await Promise.all([savePlaylists(), saveLiked(), savePending()]);
  render();
  toast(plan.missing ? `Restored. Add the missing songs and they’ll go back in place.` : 'Restored!', 5000);
}

// ---------- Now playing UI ----------

function renderNowPlaying() {
  const s = player.song;
  $('mini').hidden = !s;
  document.body.classList.toggle('has-mini', !!s);
  if (!s) {
    if (!$('player').hidden) closePlayer();
    return;
  }
  $('miniTitle').textContent = s.title;
  $('miniSub').textContent = s.artist;
  $('pTitle').textContent = s.title;
  $('pArtist').textContent = s.artist;
  setImg($('miniArt'), s.art);
  setImg($('bigArt'), s.art);
  artUrl(s.art).then((u) => {
    $('playerBg').style.backgroundImage = u ? `url("${u}")` : '';
  });
  renderLike();
  renderPlayState();
  renderTime();
  renderModes();
}

// Highlights the playing song in lists.
function markCurrent() {
  const cur = Q.current(player.q);
  for (const r of document.querySelectorAll('.row.song')) r.classList.toggle('current', r.dataset.id === cur);
}

function renderLike() {
  const s = player.song;
  const on = s && S.likedSet.has(s.id);
  $('pLike').innerHTML = on ? ICON.heartOn : ICON.heart;
  $('pLike').setAttribute('aria-label', on ? 'Unlike' : 'Like');
}

function renderPlayState() {
  const p = player.playing;
  $('miniPlay').innerHTML = p ? ICON.pause : ICON.play;
  $('pPlay').innerHTML = p ? ICON.pause : ICON.play;
  $('miniPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
  $('pPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
  document.body.classList.toggle('is-playing', p);
}

let seeking = false;
function renderTime() {
  const a = player.audio;
  const s = player.song;
  const d = isFinite(a.duration) && a.duration > 0 ? a.duration : s && s.durationMs ? s.durationMs / 1000 : 0;
  const t = a.currentTime || 0;
  $('miniBar').style.width = d ? `${(t / d) * 100}%` : '0';
  if (!seeking) {
    $('seek').value = d ? Math.round((t / d) * 1000) : 0;
    $('tCur').textContent = L.formatTime(t);
  }
  $('seek').style.setProperty('--p', `${($('seek').value / 10).toFixed(1)}%`);
  $('tDur').textContent = L.formatTime(d);
}

function renderModes() {
  const q = player.q;
  $('pShuffle').classList.toggle('on', q.shuffle);
  $('pShuffle').setAttribute('aria-pressed', q.shuffle);
  $('pRepeat').innerHTML = q.repeat === 'one' ? ICON.repeatOne : ICON.repeat;
  $('pRepeat').classList.toggle('on', q.repeat !== 'off');
  $('pRepeat').setAttribute('aria-label', { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: this song' }[q.repeat]);
  markCurrent();
}

function openPlayer() {
  if (!player.song) return;
  const p = $('player');
  p.hidden = false;
  document.body.classList.add('player-open');
  requestAnimationFrame(() => p.classList.add('open'));
}

function closePlayer() {
  const p = $('player');
  p.classList.remove('open');
  document.body.classList.remove('player-open');
  setTimeout(() => { if (!p.classList.contains('open')) p.hidden = true; }, 260);
}

function renderQueueSheet() {
  const body = $('sheetBody');
  body.replaceChildren();
  const q = player.q;
  const cur = Q.currentEntry(q);
  body.append(el('div', { class: 'sheet-head' }, el('div', { class: 'row-text' },
    el('div', { class: 't1' }, 'Up next'),
    el('div', { class: 't2' }, [q.shuffle ? 'Shuffle on' : '', q.repeat !== 'off' ? (q.repeat === 'one' ? 'Repeating this song' : 'Repeating the queue') : ''].filter(Boolean).join(' · ') || count(q.items.length, 'song') + ' in queue'))));
  if (cur) {
    const s = S.songs.get(cur.id);
    if (s) body.append(el('div', { class: 'row queue-row current' }, thumb(s.art), el('div', { class: 'row-text' },
      el('div', { class: 't1' }, s.title), el('div', { class: 't2' }, 'Now playing · ' + s.artist))));
  }
  const list = el('div', { class: 'list' });
  for (const e of Q.upNext(q).slice(0, 300)) {
    const s = S.songs.get(e.id);
    if (!s) continue;
    list.append(el('div', { class: 'row queue-row' },
      el('div', { class: 'row-main', role: 'button', tabindex: '0', onclick: () => player.jumpTo(e.pos) },
        thumb(s.art), el('div', { class: 'row-text' }, el('div', { class: 't1' }, s.title), el('div', { class: 't2' }, s.artist))),
      e.pos > q.index + 1 ? el('button', { class: 'icon-btn sm', 'aria-label': 'Move up', html: ICON.up, onclick: () => player.move(e.pos, e.pos - 1) }) : null,
      el('button', { class: 'icon-btn sm', 'aria-label': 'Remove from queue', html: ICON.close, onclick: () => player.removeAt(e.pos) })));
  }
  if (!list.children.length) list.append(el('p', { class: 'hint' }, q.repeat === 'all' ? 'The queue starts again after this song.' : 'Nothing after this song.'));
  body.append(list);
}

function openQueue() {
  openSheet('queue', () => {});
  renderQueueSheet();
}

// ---------- Install screen ----------

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function showInstall() {
  const box = $('install');
  const ios = isIOS();
  box.replaceChildren(el('div', { class: 'install-card' },
    el('img', { src: 'icons/icon-192.png', class: 'install-logo', alt: '' }),
    el('h2', null, 'Isaialai', el('span', { class: 'ta' }, ' இசையலை')),
    el('p', { class: 'lead' }, 'Add it to your Home Screen. It then opens full screen like a real app and keeps playing when you lock the phone.'),
    el('ol', { class: 'steps' },
      ios
        ? [
            el('li', null, 'Tap ', el('span', { class: 'kbd', html: ICON.share }), ' ', el('b', null, 'Share'), ' in Safari (at the bottom, or under ', el('b', null, '⋯'), ' on newer iPhones).'),
            el('li', null, 'Scroll down and tap ', el('span', { class: 'kbd', html: ICON.addBox }), ' ', el('b', null, 'Add to Home Screen'), '.'),
            el('li', null, 'Leave ', el('b', null, 'Open as Web App'), ' on, and tap ', el('b', null, 'Add'), '.'),
            el('li', null, 'Open ', el('b', null, 'Isaialai'), ' from your Home Screen, then add your songs there.'),
          ]
        : [
            el('li', null, 'Open this page in Safari on your iPhone.'),
            el('li', null, 'Tap Share → Add to Home Screen.'),
            el('li', null, 'Open Isaialai from your Home Screen.'),
          ]),
    el('p', { class: 't2' }, 'Songs added in Safari stay in Safari, so add them in the Home Screen app.'),
    el('button', { class: 'btn ghost', onclick: () => { localStorage.setItem('installSkip', '1'); box.hidden = true; } },
      isStandalone() ? 'Close' : 'Continue in the browser')));
  box.hidden = false;
}

// ---------- Wiring ----------

function wire() {
  $('fileInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (files.length) importFiles(files);
  });
  $('importBtn').addEventListener('click', pickFiles);
  $('backupInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) restoreFrom(f);
  });
  $('backBtn').addEventListener('click', back);
  for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));

  $('miniOpen').addEventListener('click', openPlayer);
  $('miniPlay').addEventListener('click', () => player.toggle());
  $('miniNext').addEventListener('click', () => player.next());
  $('playerClose').addEventListener('click', closePlayer);
  $('pPlay').addEventListener('click', () => player.toggle());
  $('pPrev').addEventListener('click', () => player.prev());
  $('pNext').addEventListener('click', () => player.next());
  $('pBack10').addEventListener('click', () => player.skip(-10));
  $('pFwd10').addEventListener('click', () => player.skip(10));
  $('pShuffle').addEventListener('click', () => { player.toggleShuffle(); toast(player.q.shuffle ? 'Shuffle on' : 'Shuffle off', 1200); });
  $('pRepeat').addEventListener('click', () => {
    player.cycleRepeat();
    toast({ off: 'Repeat off', all: 'Repeating the queue', one: 'Repeating this song' }[player.q.repeat], 1200);
  });
  $('pLike').addEventListener('click', () => { const s = player.song; if (s) toggleLike(s.id); });
  $('pQueue').addEventListener('click', openQueue);
  $('pArtist').addEventListener('click', () => {
    const s = player.song;
    const a = s && L.buildIndex([s]).artists[0];
    if (a) goFromPlayer({ type: 'artist', key: a.key });
  });
  $('playerMore').addEventListener('click', () => { const s = player.song; if (s) songMenu(s); });

  const seek = $('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    const d = player.audio.duration || 0;
    $('tCur').textContent = L.formatTime((seek.value / 1000) * d);
    seek.style.setProperty('--p', `${(seek.value / 10).toFixed(1)}%`);
  });
  seek.addEventListener('change', () => {
    const d = player.audio.duration || 0;
    player.seek((seek.value / 1000) * d);
    seeking = false;
  });

  // Swipe the full player down to close it.
  let y0 = null;
  const pl = $('player');
  pl.addEventListener('touchstart', (e) => {
    y0 = e.target.closest('input,.controls') ? null : e.touches[0].clientY;
  }, { passive: true });
  pl.addEventListener('touchend', (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 90) closePlayer();
    y0 = null;
  }, { passive: true });

  $('sheet').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (sheetKind) closeSheet();
      else if (!$('player').hidden) closePlayer();
    }
  });
}

async function start() {
  wire();
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    toast('Couldn’t open the song library. Private Browsing may block it.', 8000);
  }
  render(true);
  try {
    await player.restore();
  } catch (e) {
    console.error(e);
  }
  renderNowPlaying();
  if (!isStandalone() && !localStorage.getItem('installSkip')) showInstall();
  if (isStandalone()) db.askPersist();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('No offline support', e));
  }
}

window.isaialai = { S, player }; // handy for debugging and tests
start();
