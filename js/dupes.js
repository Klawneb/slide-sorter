// Finding photos that look the same. Each photo gets a 64-bit "difference
// hash": shrink it to 9×8 grey pixels and note whether each pixel is
// brighter than the one to its right. Two scans of the same slide give
// nearly the same bits even when the files differ (re-saved, a little
// lighter or darker, slightly different size), so photos whose hashes
// differ in only a few bits are counted as duplicates.

const W = 9;
const H = 8;
const BLOCK = 8; // each hash pixel is the average of a BLOCK×BLOCK square

// Photos whose hashes differ in at most this many of the 64 bits.
export const MAX_DISTANCE = 8;

// Resolves to [high, low]: the hash as two 32-bit numbers.
export async function imageHash(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(W * BLOCK, H * BLOCK);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const grey = new Float32Array(W * H);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      grey[Math.floor(y / BLOCK) * W + Math.floor(x / BLOCK)] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
  }

  const hash = [0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      if (grey[y * W + x] > grey[y * W + x + 1]) {
        const bit = y * (W - 1) + x;
        hash[bit >> 5] = (hash[bit >> 5] | (1 << (bit & 31))) >>> 0;
      }
    }
  }
  return hash;
}

function countBits(n) {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return Math.imul((n + (n >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

const distance = (a, b) => countBits(a[0] ^ b[0]) + countBits(a[1] ^ b[1]);

// Groups of two or more ids that look alike, in the order of `ids`.
// `hashOf(id)` gives a photo's hash, or null to leave it out.
export function findDuplicates(ids, hashOf) {
  const list = ids.map(id => ({ id, hash: hashOf(id) })).filter(p => p.hash);
  // Joined into groups, so if A matches B and B matches C, all three are together.
  const parent = list.map((_, i) => i);
  const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (distance(list[i].hash, list[j].hash) <= MAX_DISTANCE) {
        const a = root(i);
        const b = root(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const groups = new Map();
  list.forEach((p, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p.id);
  });
  return [...groups.values()].filter(g => g.length > 1);
}
