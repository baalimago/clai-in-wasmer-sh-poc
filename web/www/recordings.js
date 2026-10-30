// The meetings' recordings, kept in this browser's IndexedDB by the meeting's summary path:
// the notebook holds text only. Each call resolves to null, or false for put, when the
// browser keeps no storage (a private window, blocked site data).
export class Recordings {
  constructor(indexedDB) {
    this.db = indexedDB ? new Promise((resolve) => {
      const open = indexedDB.open("minutes", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("recordings");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    }) : Promise.resolve(null);
  }

  async request(mode, use) {
    const db = await this.db;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const request = use(db.transaction("recordings", mode).objectStore("recordings"));
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(key, blob) {
    return (await this.request("readwrite", (store) => store.put(blob, key))) !== null;
  }

  get(key) {
    return this.request("readonly", (store) => store.get(key));
  }
}
