// End-to-end smoke test in Chromium (Playwright): import songs, browse, play,
// like, playlists, queue, restore after reload, delete. Real iPhone behaviour
// (background audio, lock screen) can only be checked on the phone.
// Usage: node tests/smoke.mjs [screenshot dir]
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('../web/', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const shots = process.argv[2];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/isaialai-ios/, '');
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/isaialai-ios/`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
// Capture the lock-screen handlers so the test can press them like iPhone does.
await ctx.addInitScript(() => {
  window.__ms = {};
  const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (name, fn) => { window.__ms[name] = fn; return orig(name, fn); };
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Road trip') : d.accept()));
const shot = async (name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + '.png') }); } };
const step = (s) => console.log('•', s);

try {
  await page.goto(base);
  step('install screen shows in a normal browser tab');
  await page.waitForSelector('#install:not([hidden])');
  await shot('1-install');
  await page.getByText('Continue in the browser').click();
  await page.waitForSelector('#install', { state: 'hidden' });
  await page.getByText('No songs yet', { exact: false }).waitFor();

  step('import songs');
  const files = ['tagged-v23.mp3', 'tagged-v24.mp3', 'Ilaiyaraaja - Ilaya Nila.mp3', 'tagged.m4a'].map((f) => join(fixtures, f));
  await page.setInputFiles('#fileInput', files);
  await page.getByText('Added 4 songs').waitFor({ timeout: 20000 });
  assert.equal(await page.locator('.row.song').count(), 4);
  assert.equal(await page.locator('.row.song .thumb.has').count() >= 1, true, 'cover art shown');
  await shot('2-songs');

  step('importing the same files again skips them');
  await page.setInputFiles('#fileInput', files.slice(0, 1));
  await page.getByText('Already in your library').waitFor({ timeout: 10000 });

  step('albums, artists, music directors');
  await page.getByRole('button', { name: 'Albums', exact: true }).click();
  await page.locator('.tile', { hasText: 'வாத்தி (Vaathi)' }).waitFor();
  await page.getByRole('button', { name: 'Music directors', exact: true }).click();
  await page.locator('.row', { hasText: 'G. V. Prakash Kumar' }).click();
  assert.equal(await page.locator('#title').textContent(), 'G. V. Prakash Kumar');
  assert.equal(await page.locator('.row.song').count(), 3);
  await shot('3-director');
  await page.click('#backBtn');
  await page.getByRole('button', { name: 'Artists', exact: true }).click();
  await page.locator('.row', { hasText: 'Shweta Mohan' }).waitFor();

  step('search as you type');
  await page.click('#tabs [data-tab=search]');
  await page.fill('input.search', 'ilaya');
  await page.locator('.row.song', { hasText: 'Ilaya Nila' }).waitFor();
  assert.equal(await page.locator('.row.song').count(), 1);

  step('play a song');
  await page.locator('.row.song', { hasText: 'Ilaya Nila' }).click();
  await page.waitForFunction(() => { const a = document.getElementById('audio'); return !a.paused && a.currentTime > 0.1; }, null, { timeout: 10000 });
  assert.equal(await page.locator('#miniTitle').textContent(), 'Ilaya Nila');
  const meta = await page.evaluate(() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.title);
  assert.equal(meta, 'Ilaya Nila', 'lock-screen title');

  step('full player, like, next, queue');
  await page.click('#tabs [data-tab=library]');
  await page.getByRole('button', { name: 'Songs', exact: true }).click();
  await page.locator('.row.song').first().click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await page.click('#miniOpen');
  await page.waitForSelector('#player.open');
  await page.waitForTimeout(300);
  await page.click('#pLike');
  await shot('4-player');
  await page.click('#pQueue');
  await page.waitForSelector('#sheet.open');
  assert.equal(await page.locator('#sheetBody .queue-row').count(), 4);
  await shot('5-upnext');
  await page.click('.sheet-scrim');
  await page.waitForSelector('#sheet', { state: 'hidden' });
  // Test songs are 1 s long: pause first so one can't end (and move on by itself) before the tap.
  await page.evaluate(() => window.isaialai.player.pause());
  const idx = await page.evaluate(() => window.isaialai.player.q.index);
  await page.click('#pNext');
  await page.waitForFunction((i) => window.isaialai.player.q.index === i + 1 && !document.getElementById('audio').paused, idx);
  await page.click('#pShuffle');
  assert.equal(await page.evaluate(() => window.isaialai.player.q.shuffle), true);
  await page.click('#pRepeat');
  assert.equal(await page.evaluate(() => window.isaialai.player.q.repeat), 'all');
  await page.click('#pFwd10');
  await page.click('#playerClose');
  await page.waitForSelector('#player', { state: 'hidden' });

  step('lock-screen Next switches the song straight away (no waiting)');
  await page.evaluate(() => window.isaialai.player.play());
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await page.waitForFunction(() => window.isaialai.player.urls.size >= 2); // neighbours prepared
  const sync = await page.evaluate(() => {
    const p = window.isaialai.player;
    const before = p.q.index;
    const src = p.audio.src;
    window.__ms.nexttrack({ action: 'nexttrack' });
    return { moved: p.q.index !== before, srcChanged: p.audio.src !== src };
  });
  assert.deepEqual(sync, { moved: true, srcChanged: true });
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await page.evaluate(() => window.__ms.pause({ action: 'pause' }));
  await page.waitForFunction(() => document.getElementById('audio').paused);
  await page.evaluate(() => window.__ms.play({ action: 'play' }));
  await page.waitForFunction(() => !document.getElementById('audio').paused);

  step('lock-screen artwork is a real web address the service worker answers');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForSelector('#mini:not([hidden])');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const withArt = await page.evaluate(() => [...window.isaialai.S.songs.values()].find((s) => s.art).id);
  const art = await page.evaluate(async (id) => {
    const p = window.isaialai.player;
    const ids = window.isaialai.S.index.songs.map((s) => s.id);
    await p.playList(ids, ids.indexOf(id), { shuffle: false });
    const src = navigator.mediaSession.metadata.artwork[0].src;
    const res = await fetch(src);
    return { src, type: res.headers.get('content-type'), size: (await res.blob()).size };
  }, withArt);
  assert.match(art.src, /\/art\/a/);
  assert.equal(art.type, 'image/jpeg');
  assert.ok(art.size > 100);
  await page.click('#tabs [data-tab=settings]');
  await page.getByText('Last button from the lock screen: Play', { exact: false }).waitFor();
  await page.getByText('Cover art for the lock screen: ready.').waitFor();

  step('liked songs and playlists');
  await page.click('#tabs [data-tab=playlists]');
  await page.locator('.row', { hasText: 'Liked songs' }).click();
  assert.equal(await page.locator('.row.song').count(), 1);
  await page.click('#backBtn');
  await page.locator('.row', { hasText: 'New playlist' }).click();
  await page.locator('.row', { hasText: 'Road trip' }).waitFor();
  await page.click('#tabs [data-tab=library]');
  await page.locator('.row.song .row-more').nth(1).click();
  await page.getByRole('button', { name: 'Add to playlist…' }).click();
  await page.locator('.sheet-item', { hasText: 'Road trip' }).click();
  await page.click('#tabs [data-tab=playlists]');
  await page.locator('.row', { hasText: 'Road trip' }).click();
  assert.equal(await page.locator('.row.song').count(), 1);
  await page.locator('.row.song .row-more').first().click();
  await page.getByRole('button', { name: 'Remove from this playlist' }).click();
  await page.getByText('Empty for now', { exact: false }).waitFor();

  step('pause and reload: queue and position come back');
  await page.click('#miniPlay');
  await page.waitForFunction(() => document.getElementById('audio').paused);
  const before = await page.evaluate(() => ({ t: document.getElementById('miniTitle').textContent, n: window.isaialai.player.q.items.length }));
  await page.reload();
  await page.waitForSelector('#mini:not([hidden])');
  const after = await page.evaluate(() => ({ t: document.getElementById('miniTitle').textContent, n: window.isaialai.player.q.items.length }));
  assert.deepEqual(after, before);
  assert.equal(await page.evaluate(() => window.isaialai.player.q.repeat), 'all');

  step('settings shows storage; delete a song');
  await page.click('#tabs [data-tab=settings]');
  await page.getByText('4 songs', { exact: false }).waitFor();
  await shot('6-settings');
  await page.click('#tabs [data-tab=library]');
  await page.locator('.row.song .row-more').first().click();
  await page.getByRole('button', { name: 'Delete from Isaialai' }).click();
  await page.getByText('Deleted 1 song').waitFor();
  assert.equal(await page.locator('.row.song').count(), 3);
  assert.equal(await page.evaluate(() => window.isaialai.player.q.items.length), 3);

  step('back up, lose a playlist, restore it');
  await page.click('#tabs [data-tab=settings]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Back up now' }).click()]);
  assert.equal(download.suggestedFilename(), 'Isaialai backup.json');
  const backupPath = await download.path();
  const saved = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(saved.app, 'Isaialai');
  assert.equal(saved.playlists[0].name, 'Road trip');
  await page.getByText('Last backup: today').waitFor();
  await page.evaluate(async () => {
    const S = window.isaialai.S;
    S.playlists.length = 0; // as if the app was deleted and reinstalled
  });
  await page.setInputFiles('#backupInput', backupPath);
  await page.getByText('Restored!').waitFor();
  assert.deepEqual(await page.evaluate(() => window.isaialai.S.playlists.map((p) => p.name)), ['Road trip']);

  step('restore an Android backup before adding its song, then add the song');
  await page.setInputFiles('#backupInput', join(fixtures, 'android-backup.json'));
  await page.getByText('Add the missing songs', { exact: false }).waitFor();
  await page.getByText('1 song from a backup will go back', { exact: false }).waitFor();
  await page.setInputFiles('#fileInput', join(fixtures, 'Ilaiyaraaja - Ilaya Nila.mp3'));
  await page.getByText('1 song put back in your playlists', { exact: false }).waitFor({ timeout: 15000 });
  const raja = await page.evaluate(() => {
    const S = window.isaialai.S;
    const p = S.playlists.find((x) => x.name === 'Raja');
    return { songs: p.songs.map((id) => S.songs.get(id).title), liked: S.liked.map((id) => S.songs.get(id).title).includes('Ilaya Nila'), pending: S.pending };
  });
  assert.deepEqual(raja, { songs: ['Ilaya Nila'], liked: true, pending: null });

  step('import the Android app\'s zip: songs plus playlists from the backup inside');
  await page.click('#tabs [data-tab=settings]');
  await page.getByRole('button', { name: 'Delete all songs' }).click();
  await page.getByText('Deleted 4 songs').waitFor();
  await page.evaluate(() => { window.isaialai.S.playlists.length = 0; });
  await page.setInputFiles('#fileInput', join(fixtures, 'android-songs.zip'));
  await page.getByText('Restored!').waitFor({ timeout: 20000 });
  const z = await page.evaluate(() => {
    const S = window.isaialai.S;
    const songs = [...S.songs.values()];
    return {
      paths: songs.map((s) => s.path).sort(),
      raja: S.playlists.find((p) => p.name === 'Raja').songs.map((id) => S.songs.get(id).title),
    };
  });
  assert.deepEqual(z.paths, ['Download/tagged.m4a', 'Music/Ilaiyaraaja/Ilaiyaraaja - Ilaya Nila.mp3', 'Music/Vaathi/tagged-v23.mp3']);
  assert.deepEqual(z.raja, ['Ilaya Nila']);
  await page.click('#tabs [data-tab=library]');
  await page.getByRole('button', { name: 'Songs', exact: true }).click();
  assert.equal(await page.locator('.row.song').count(), 3);
  await page.locator('.row.song', { hasText: 'Vaa Vaathi' }).first().click();
  await page.waitForFunction(() => { const a = document.getElementById('audio'); return !a.paused && a.currentTime > 0.1; }, null, { timeout: 10000 });

  step('service worker and offline reload');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await ctx.setOffline(true);
  await page.reload();
  await page.locator('.row.song').first().waitFor();
  assert.equal(await page.locator('.row.song').count(), 3);
  await ctx.setOffline(false);

  const real = errors.filter((e) => !/favicon|Failed to load resource.*(net::ERR_INTERNET_DISCONNECTED)/.test(e));
  assert.deepEqual(real, [], 'no console errors');
  console.log('Smoke test passed');
} catch (e) {
  await shot('failure');
  console.error('Console errors:', errors);
  throw e;
} finally {
  await browser.close();
  server.close();
}
