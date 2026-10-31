# 🎧 Isaialai (இசையலை) for iPhone

*Isaialai* means "music wave" in Tamil. This is the iPhone version of
[Isaialai for Android](https://github.com/Akrishna87/isaialai): a music player
for **your own songs** (mp3 and m4a), made as a web app you add to your Home
Screen. No App Store, no account, no ads, and your songs never leave the phone.

**Open it on your iPhone:** https://akrishna87.github.io/isaialai-ios/

## Installing it

1. Open the link above in **Safari** on your iPhone.
2. Tap **Share** (the square with an arrow; on newer iPhones it's under **⋯**).
3. Scroll down and tap **Add to Home Screen**, leave **Open as Web App** on, and tap **Add**.
4. Open **Isaialai** from your Home Screen.
5. Tap **+** and pick songs from the Files app (On My iPhone, iCloud Drive, or
   files you AirDropped from a computer).

**Moving from Isaialai on Android?** On Android, use **Pack all songs into a
zip**, then get the zip onto the iPhone (AirDrop from a computer, iCloud Drive
or Google Drive → Save to Files). In Isaialai on iPhone tap **+** and pick the
zip. Your songs are added, then your playlists and Liked songs from the backup
inside the zip.

Add songs **in the Home Screen app**, not in a Safari tab: iPhone keeps the two
separately.

## What it does

- **Library:** Songs, Albums, Artists and **Music directors** (from the
  Composer tag: Ilaiyaraaja, A.R. Rahman, Anirudh…), with each director's
  movies, newest first.
- **Search** songs, artists, movies and music directors as you type (Tamil text too).
- **Player:** mini player and full player with cover art, seek bar,
  ⏪ 10 s / ⏩ 10 s, previous/next, shuffle, repeat (all / one) and **Up next**
  (jump, move up, remove). Play next and Add to queue from any song's ⋯ menu.
- Keeps playing with the screen locked, with lock-screen and Control Centre
  controls and cover art. AirPlay works from Control Centre.
- Remembers your queue and where you were in the song.
- **Liked songs** and your own **playlists** (create, add, remove, rename, delete).
- Reads title, artist, album, music director, year, track and cover art from
  the songs' tags, or uses the file name when there are none.
- **Android zip:** pick the Android app's **Pack all songs into a zip** file
  with **+** to add all the songs and restore the playlists and likes inside it.
  The zip is read straight from Files, one song at a time, so even a zip of
  several GB works (as long as the iPhone has room).
- **Backup & restore** (Settings): saves your playlists and Liked songs to
  `Isaialai backup.json` with the Share sheet (→ Save to Files), and restores
  it. Uses the same format as the Android app, so backups move both ways.
  Songs are matched by file name, length and title/artist. If you restore
  before adding the songs, they go back into their playlists as you add them.
- **Settings:** storage used, delete songs, and lock-screen buttons.
- Works offline once installed.

## What an iPhone web app can't do

- **See your music library.** Songs are copied into the app when you add them.
- **Volume tricks.** iPhone ignores a web app's volume, and the trick that
  would allow an equaliser stops the music in the background. So there's no
  equaliser, bass or volume boost, even volume, crossfade or fade-out. Use the
  phone's volume buttons.
- **Both kinds of lock-screen buttons at once.** iPhone shows either
  ⏮ ⏭ (songs) or ⏪ ⏩ (10 seconds). Pick in Settings → Lock screen buttons.

## Coming later

- Import .m3u playlists.
- Instant mix and Your recap.
- Lyrics.
- Sleep timer and playback speed.

## For developers

Plain HTML, CSS and JavaScript modules in [`web/`](web), with no build step.

| File | What it does |
| --- | --- |
| `web/js/app.js` | Screens, menus, importing songs |
| `web/js/player.js` | The `<audio>` element, lock-screen controls (Media Session), saving the queue |
| `web/js/queue.js` | The play queue: shuffle, repeat, play next, up next (pure functions) |
| `web/js/library.js` | Albums, artists, music directors and search (pure functions) |
| `web/js/tags.js` | Reads ID3v2.2/2.3/2.4, ID3v1 and M4A tags and cover art |
| `web/js/backup.js` | Backup file (same format as Android), matching songs, restoring (pure functions) |
| `web/js/zip.js` | Reads zips straight from the file (stored, deflate, ZIP64, Java's sizes-after-data) |
| `web/js/db.js` | Song files in OPFS (or IndexedDB on older iPhones), everything else in IndexedDB |
| `web/sw.js` | Offline app shell. Songs are never put in the service worker cache |

```sh
npm test                      # unit tests (Node 20+)
npm run serve                 # http://localhost:8080
npm i --no-save playwright && node tests/smoke.mjs shots/   # browser smoke test
```

Pushing to `main` runs the tests and publishes `web/` to GitHub Pages
(`.github/workflows/pages.yml`). In the repo's **Settings → Pages**,
**Source** must be **GitHub Actions**.
