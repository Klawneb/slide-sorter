// IndexedDB storage. Photos (original file + thumbnail) live in the "photos"
// store; the arrangement of groups lives under one key in the "meta" store.

const DB_NAME = 'slide-sorter';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('photos', { keyPath: 'id' });
        db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const result = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const putPhoto = photo => run('photos', 'readwrite', s => { s.put(photo); });
export const getAllPhotos = () => run('photos', 'readonly', s => s.getAll());
export const deletePhotos = ids => run('photos', 'readwrite', s => { ids.forEach(id => s.delete(id)); });
export const saveState = state => run('meta', 'readwrite', s => { s.put(state, 'state'); });
export const loadState = () => run('meta', 'readonly', s => s.get('state'));

export const clearAll = () => open().then(db => new Promise((resolve, reject) => {
  const tx = db.transaction(['photos', 'meta'], 'readwrite');
  tx.objectStore('photos').clear();
  tx.objectStore('meta').clear();
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
}));
