// Minimal ZIP writer. Files are stored uncompressed: JPEGs don't shrink
// anyway, and the photo bytes are copied exactly as they were.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  if (date.getFullYear() < 1980) date = new Date(1980, 0, 1); // earliest a ZIP can store
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name, blob, date? }], where blob may be a function returning a
// Promise of the Blob so files are prepared one at a time. Returns the ZIP Blob.
export async function makeZip(entries, onProgress = () => {}) {
  if (entries.length > 0xffff) throw new Error('Too many files for one ZIP.');

  const encoder = new TextEncoder();
  const now = new Date();
  const parts = [];
  const central = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const { name } = entries[i];
    const blob = typeof entries[i].blob === 'function' ? await entries[i].blob() : entries[i].blob;
    const { time, day } = dosDateTime(entries[i].date || now);
    const nameBytes = encoder.encode(name);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
    const size = blob.size;

    if (offset + 30 + nameBytes.length + size > 0xffffffff) {
      throw new Error('The photos add up to more than 4 GB, which is too big for one ZIP.');
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true);         // version needed
    local.setUint16(6, 0x0800, true);     // flags: UTF-8 names
    local.setUint16(8, 0, true);          // method: stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);      // compressed size
    local.setUint32(22, size, true);      // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);         // extra length
    parts.push(local.buffer, nameBytes, blob);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);    // central directory signature
    cd.setUint16(4, 20, true);            // version made by
    cd.setUint16(6, 20, true);            // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, day, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);            // extra length
    cd.setUint16(32, 0, true);            // comment length
    cd.setUint16(34, 0, true);            // disk number
    cd.setUint16(36, 0, true);            // internal attributes
    cd.setUint32(38, 0, true);            // external attributes
    cd.setUint32(42, offset, true);       // local header offset
    central.push(cd.buffer, nameBytes);

    offset += 30 + nameBytes.length + size;
    onProgress(i + 1, entries.length);
  }

  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);     // end of central directory signature
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
