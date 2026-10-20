# Slide Sorter

A small PWA for putting scanned photos into named groups (e.g. "Christmas 1980"),
ordering them, and exporting copies with filenames that sort in that order:

```
01 - Christmas 1980 - 001.jpg
01 - Christmas 1980 - 002.jpg
02 - Beach 1982 - 001.jpg
```

Plain HTML/CSS/JS, no build step and no dependencies. Original files are never
modified; the app works on copies stored in the browser (IndexedDB).

## Run locally

```
python -m http.server 8765
```

Then open http://localhost:8765.

## Put it on the tablet

Service workers and the folder picker need HTTPS, so host the folder on any static
host (GitHub Pages, Netlify, Cloudflare Pages). Open the URL in Chrome on the
tablet, then use the menu → "Add to Home screen" / "Install app".

After changing files, bump `CACHE` in `sw.js` so installed copies refresh their offline cache.

## Export

- **Save into a folder**: used when the browser supports `showDirectoryPicker`.
  Writes the renamed copies straight into a folder the user picks.
- **Download as a ZIP**: always available. Files are stored uncompressed, byte for byte.

## Files

- `js/app.js`: UI, state, import/export
- `js/db.js`: IndexedDB storage
- `js/zip.js`: minimal ZIP writer
- `sw.js`: offline cache
