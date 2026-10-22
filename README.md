# Slide Sorter

A small PWA for tagging scanned film slides (e.g. "1980", "Christmas", "Beach"),
browsing them by tag, and exporting copies that sort correctly in both
Samsung Gallery (by filename) and Google Photos (by date taken).

Live: https://klawneb.github.io/slide-sorter/

## How export works

Each photo is exported once, into one folder:

```
1980 - 0001 - Christmas, Family.jpg
1980 - 0002 - July, Beach.jpg
Undated - 0157 - Beach.jpg
```

- Photos sort by **year tag** (any tag that is a 4-digit year), then **month tag**
  (optional, "July"/"Jul"), then by their **other tags**, then the order arranged in the app.
  Photos without a year come last. Grouping compares each photo's tags most-used first, so
  photos sharing common tags sit together (e.g. Beach, then Beach + London, then London),
  and untagged ones go after them. Filenames list the tags in that same order.
- The running number comes before the other tags, so sorting by filename keeps that order.
- For JPEGs with a year tag, the EXIF date taken is set to the 1st of that month
  (January if no month), one minute apart in order. The tags are written to the
  EXIF description and Windows "Tags" field. The image data is not re-encoded,
  and the EXIF orientation is kept.
- Undated photos are copied byte for byte.

Original files are never modified; the app works on copies stored in the browser (IndexedDB).

## Run locally

```
python -m http.server 8765
```

Then open http://localhost:8765.

## Deploying

Pushing to `main` redeploys GitHub Pages. After changing files, bump `CACHE` in
`sw.js` so installed copies refresh their offline cache.

## Files

- `js/app.js`: UI, state, import/export
- `js/tags.js`: tag rules (years, months), display order, export filenames and dates
- `js/exif.js`: lossless JPEG EXIF date writer
- `js/dupes.js`: finding photos that look the same (difference hash)
- `js/zip.js`: minimal ZIP writer
- `js/db.js`: IndexedDB storage
- `sw.js`: offline cache
