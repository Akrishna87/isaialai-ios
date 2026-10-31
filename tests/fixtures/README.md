# Test fixtures

- `tagged-*.mp3`, `tagged*.m4a`, `Ilaiyaraaja - Ilaya Nila.mp3`: 1–2 s tones made with ffmpeg, with
  ID3v2.3/2.4 or iTunes tags (Tamil text included), with or without cover art.
- `android-backup.json`: shaped like the Android app's `Isaialai backup.json` (format 1).
- `android-songs.zip`: made with Python's zipfile writing to a non-seekable stream, so each file has its
  sizes after the data (like Java), plus a stored file, a non-song and a `../` path that must be skipped.
- `android-java.zip`: made with `java.util.zip.ZipOutputStream` and `Deflater.NO_COMPRESSION`,
  the same calls as the Android app's `MusicZip.pack`.
