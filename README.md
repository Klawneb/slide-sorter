# Slide Sorter

A small PWA for tagging scanned film slides (e.g. "1980", "Christmas", "Beach"),
browsing them by tag, and exporting copies that sort correctly in both
Samsung Gallery (by filename) and Google Photos (by date taken).

Live: https://klawneb.github.io/slide-sorter/

## How export works

Each photo is exported once, into one folder:

```
1980 - Beach - 0001.jpg
1980 - Beach, London - 0002.jpg
1980 - Christmas, Family - 0003.jpg
1980-07 - Beach - 0004.jpg
Undated - Beach - 0157.jpg
```

- The name starts with the **year tag** (any tag that is a 4-digit year) and **month tag**
  (optional, "July"/"Jul", written as `1980-07`), then the **other tags**, least-used first
  (tags on only one photo last), so specific tags like an event decide the group before
  broad ones like "Family". Sorting by filename therefore groups photos with the same tags
  within each year (e.g. all "Wedding" photos together, whether or not they're also tagged
  "Family"). Photos without a year come last.
- The running number comes last and keeps the order arranged in the app within a group.
  The app shows photos in exactly this filename order.
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
