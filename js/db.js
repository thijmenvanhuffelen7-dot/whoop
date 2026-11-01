// Lokale opslag in IndexedDB. Er gaat niets naar een server.
//  records: metingen (hrv, breath, session/training, night)
//  days:    dagtotalen (inspanning, zones, kcal, stress) per datum
//  journal: dagboek per datum
const DB_NAME = 'whoop-local';
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB niet beschikbaar')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const s = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date', 'date');
        s.createIndex('type', 'type');
      }
      if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  // Metingen
  add: (rec) => tx('records', 'readwrite', (s) => s.add(rec)),
  put: (rec) => tx('records', 'readwrite', (s) => s.put(rec)),
  get: (id) => tx('records', 'readonly', (s) => s.get(id)),
  remove: (id) => tx('records', 'readwrite', (s) => s.delete(id)),
  async all() {
    const list = (await tx('records', 'readonly', (s) => s.getAll())) || [];
    return list.sort((a, b) => b.date - a.date);
  },
  // Dagtotalen en dagboek
  putIn: (store, rec) => tx(store, 'readwrite', (s) => s.put(rec)),
  getIn: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  allIn: async (store) => (await tx(store, 'readonly', (s) => s.getAll())) || [],
  deleteIn: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  async clear() {
    for (const s of ['records', 'days', 'journal']) await tx(s, 'readwrite', (st) => st.clear());
  },
};
