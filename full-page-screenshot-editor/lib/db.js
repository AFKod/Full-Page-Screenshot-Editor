const DATABASE = "full-page-screenshot-editor-v1";
let connection;

export function openDB() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("captures", { keyPath: "id" });
      const frames = db.createObjectStore("frames", { keyPath: ["captureId", "index"] });
      frames.createIndex("captureId", "captureId");
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
  });
  return connection;
}

async function transaction(stores, mode, run) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result?.result);
    tx.onabort = () => reject(tx.error || new Error("Операция IndexedDB отменена."));
    tx.onerror = () => reject(tx.error);
    result = run(tx);
  });
}

export const putCapture = capture => transaction(["captures"], "readwrite", tx => tx.objectStore("captures").put(capture));
export const getCapture = id => transaction(["captures"], "readonly", tx => tx.objectStore("captures").get(id));
export const listCaptures = () => transaction(["captures"], "readonly", tx => tx.objectStore("captures").getAll());
export const putFrame = frame => transaction(["frames"], "readwrite", tx => tx.objectStore("frames").put(frame));
export const getFrame = (id, index) => transaction(["frames"], "readonly", tx => tx.objectStore("frames").get([id, index]));

export async function closeDB() {
  const pending = connection;
  connection = undefined;
  if (pending) (await pending.catch(() => null))?.close();
}

// Delete the whole database, including orphan frames and failed-capture metadata.
// Other editor connections close in onversionchange; callers stop writers first.
export async function deleteAllData() {
  await closeDB();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function deleteCapture(id) {
  return transaction(["captures", "frames"], "readwrite", tx => {
    tx.objectStore("captures").delete(id);
    const request = tx.objectStore("frames").index("captureId").openKeyCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { tx.objectStore("frames").delete(cursor.primaryKey); cursor.continue(); }
    };
  });
}

export async function pruneCaptures(exceptId, now = Date.now()) {
  for (const capture of await listCaptures()) {
    if (capture.id !== exceptId && now - capture.createdAt > 24 * 60 * 60 * 1000) await deleteCapture(capture.id);
  }
}
