// Almacenamiento local (IndexedDB): metadatos y audio en almacenes separados
// para que la lista cargue rápido sin leer todos los archivos de audio.

const DB_NAME = 'sonometro';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) { reject(new Error('IndexedDB no disponible')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

function run(stores, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    fn(tx, (v) => { result = v; });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export function addRecording(meta, wav) {
  return run(['meta', 'audio'], 'readwrite', (tx, set) => {
    const r = tx.objectStore('meta').add(meta);
    r.onsuccess = () => { set(r.result); tx.objectStore('audio').put(wav, r.result); };
  });
}

export function listMeta() {
  return run(['meta'], 'readonly', (tx, set) => {
    const r = tx.objectStore('meta').getAll();
    r.onsuccess = () => set(r.result || []);
  });
}

export function getAudio(id) {
  return run(['audio'], 'readonly', (tx, set) => {
    const r = tx.objectStore('audio').get(id);
    r.onsuccess = () => set(r.result);
  });
}

export function deleteRecording(id) {
  return run(['meta', 'audio'], 'readwrite', (tx) => {
    tx.objectStore('meta').delete(id);
    tx.objectStore('audio').delete(id);
  });
}

export function clearAll() {
  return run(['meta', 'audio'], 'readwrite', (tx) => {
    tx.objectStore('meta').clear();
    tx.objectStore('audio').clear();
  });
}
