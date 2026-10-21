// Writes a "date taken" (plus the tags as a description) into a JPEG without
// re-encoding the image: the old EXIF block is swapped for a new one and the
// image data is copied unchanged.

const encoder = new TextEncoder();
const ASCII = 2, SHORT = 3, LONG = 4, BYTE = 1, UNDEFINED = 7;

function exifDate(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const entry = (tag, type, data) => ({ tag, type, count: type === SHORT ? data.length / 2 : type === LONG ? data.length / 4 : data.length, data });
const ascii = (tag, text) => entry(tag, ASCII, new Uint8Array([...encoder.encode(text), 0]));
const short = (tag, value) => entry(tag, SHORT, new Uint8Array([value & 0xff, value >> 8]));
const long = (tag, value) => {
  const data = new Uint8Array(4);
  new DataView(data.buffer).setUint32(0, value, true);
  return entry(tag, LONG, data);
};
// Windows "Tags" field: UTF-16LE text.
function utf16(tag, text) {
  const data = new Uint8Array((text.length + 1) * 2);
  for (let i = 0; i < text.length; i++) {
    data[i * 2] = text.charCodeAt(i) & 0xff;
    data[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return entry(tag, BYTE, data);
}

const padded = n => n + (n & 1);
const ifdSize = entries => 2 + entries.length * 12 + 4
  + entries.reduce((n, e) => n + (e.data.length > 4 ? padded(e.data.length) : 0), 0);

// Little-endian IFD at `offset`; values over 4 bytes go right after it.
function writeIfd(bytes, offset, entries) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  entries.sort((a, b) => a.tag - b.tag);
  view.setUint16(offset, entries.length, true);
  let dataAt = offset + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = offset + 2 + i * 12;
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    view.setUint32(p + 4, e.count, true);
    if (e.data.length <= 4) {
      bytes.set(e.data, p + 8);
    } else {
      view.setUint32(p + 8, dataAt, true);
      bytes.set(e.data, dataAt);
      dataAt += padded(e.data.length);
    }
  });
  view.setUint32(offset + 2 + entries.length * 12, 0, true); // no next IFD
}

function buildApp1({ date, tags, orientation }) {
  const when = exifDate(date);
  const ifd0 = [ascii(0x0131, 'Slide Sorter'), ascii(0x0132, when)];
  if (tags.length) {
    ifd0.push(ascii(0x010e, tags.join(', ')));  // ImageDescription
    ifd0.push(utf16(0x9c9e, tags.join(';')));   // XPKeywords
  }
  if (orientation) ifd0.push(short(0x0112, orientation));
  const pointer = long(0x8769, 0);
  ifd0.push(pointer);
  const exifIfd = [
    entry(0x9000, UNDEFINED, encoder.encode('0232')), // ExifVersion
    ascii(0x9003, when),                               // DateTimeOriginal
    ascii(0x9004, when),                               // DateTimeDigitized
  ];

  const exifAt = 8 + ifdSize(ifd0);
  new DataView(pointer.data.buffer).setUint32(0, exifAt, true);
  const tiff = new Uint8Array(exifAt + ifdSize(exifIfd));
  tiff.set([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]); // "II*\0", IFD0 at 8
  writeIfd(tiff, 8, ifd0);
  writeIfd(tiff, exifAt, exifIfd);

  const length = 2 + 6 + tiff.length;
  if (length > 0xffff) throw new Error('Too many tags to store in the photo.');
  const seg = new Uint8Array(2 + length);
  seg.set([0xff, 0xe1, length >> 8, length & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]); // APP1 "Exif\0\0"
  seg.set(tiff, 10);
  return seg;
}

// Orientation from an existing EXIF block, so rotated scans stay upright.
function readOrientation(tiff) {
  try {
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const le = view.getUint16(0) === 0x4949;
    const ifd = view.getUint32(4, le);
    const count = view.getUint16(ifd, le);
    for (let i = 0; i < count; i++) {
      const p = ifd + 2 + i * 12;
      if (view.getUint16(p, le) === 0x0112) return view.getUint16(p + 8, le);
    }
  } catch {
    // unreadable EXIF: treat as no orientation
  }
  return 0;
}

// Width, height and EXIF orientation from a JPEG's header, read from just
// the first part of the file. Null if it isn't a JPEG or can't be read.
export async function jpegInfo(blob) {
  const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return null;
  let orientation = 0;
  let pos = 2;
  while (pos + 9 < head.length && head[pos] === 0xff) {
    const marker = head[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    const length = (head[pos + 2] << 8) | head[pos + 3];
    if (marker === 0xe1 && startsWith(head, pos + 4, 'Exif\0\0')) {
      orientation = readOrientation(head.subarray(pos + 10, pos + 2 + length));
    }
    // SOF0-SOF15, except DHT (c4), JPG (c8) and DAC (cc), hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: (head[pos + 5] << 8) | head[pos + 6],
        width: (head[pos + 7] << 8) | head[pos + 8],
        orientation,
      };
    }
    if (marker === 0xda) break;
    pos += 2 + length;
  }
  return null;
}

const startsWith = (bytes, at, text) => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

// Returns a new JPEG Blob with the date and tags set, or null if the file
// isn't a JPEG this can safely edit.
export async function setJpegDate(blob, { date, tags = [] }) {
  const head = new Uint8Array(await blob.arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return null;

  const app0 = [];
  const others = [];
  let orientation = 0;
  let pos = 2;
  for (;;) {
    if (pos + 4 > head.length || head[pos] !== 0xff) return null;
    const marker = head[pos + 1];
    if (marker === 0xff) { pos++; continue; } // fill byte
    if (marker === 0xda) break;               // start of image data
    const end = pos + 2 + ((head[pos + 2] << 8) | head[pos + 3]);
    if (end > head.length) return null;
    const seg = head.subarray(pos, end);
    if (marker === 0xe1 && startsWith(seg, 4, 'Exif\0\0')) {
      orientation = orientation || readOrientation(seg.subarray(10));
    } else if (marker === 0xe1 && startsWith(seg, 4, 'http://ns.adobe.com/xap/1.0/\0')) {
      // Old XMP could carry its own date and contradict the new one.
    } else if (marker === 0xe0) {
      app0.push(seg);
    } else {
      others.push(seg);
    }
    pos = end;
  }

  const app1 = buildApp1({ date, tags, orientation });
  return new Blob([head.subarray(0, 2), ...app0, app1, ...others, blob.slice(pos)], { type: 'image/jpeg' });
}
