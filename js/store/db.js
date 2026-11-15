// IndexedDB storage. Database `roast-tracker`, version 1:
//   roasts (key `id`)  - roast records
//   meta   (key `key`) - { key, value }, e.g. lastExportAt
// The reference rules are pure functions below so they can be tested without a browser.

const DB_NAME = 'roast-tracker';
const DB_VERSION = 1;

// ---- Reference rules (pure) ----

export const normalizeName = (s) => String(s ?? '').trim().toLowerCase();

const flagsOf = (r) => ({ coffee: !!r.reference?.coffee, general: !!r.reference?.general });

// Sets the reference flags on roast `id` and clears them on any roast they would
// otherwise duplicate: one coffee-reference per coffee name (case-insensitive, trimmed)
// and one general reference overall. A flag that is not passed is left as it is.
// Returns the changed roasts as new objects; the input is not modified.
export function applyReferenceFlags(roasts, id, { coffee, general } = {}) {
  const target = roasts.find((r) => r.id === id);
  if (!target) throw new Error(`No roast with id ${id}`);
  const want = { ...flagsOf(target) };
  if (coffee !== undefined) want.coffee = !!coffee;
  if (general !== undefined) want.general = !!general;

  const changed = [];
  const name = normalizeName(target.coffee);
  for (const r of roasts) {
    const have = flagsOf(r);
    let next;
    if (r.id === id) {
      next = want;
    } else {
      next = { ...have };
      if (want.coffee && have.coffee && normalizeName(r.coffee) === name) next.coffee = false;
      if (want.general && have.general) next.general = false;
    }
    if (next.coffee !== have.coffee || next.general !== have.general) {
      changed.push({ ...r, reference: next });
    }
  }
  return changed;
}

// Its own reference if the coffee has one, else the general one, else null (Starter guardrails).
export function pickReference(roasts, coffeeName) {
  const newestFirst = [...roasts].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const name = normalizeName(coffeeName);
  const own = name && newestFirst.find((r) => r.reference?.coffee && normalizeName(r.coffee) === name);
  return own || newestFirst.find((r) => r.reference?.general) || null;
}

// ---- IndexedDB ----

let dbPromise = null;

export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('roasts')) db.createObjectStore('roasts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => { dbPromise = null; reject(open.error); };
      open.onblocked = () => { dbPromise = null; reject(new Error('Database is blocked by another tab')); };
    });
    dbPromise.catch(() => { dbPromise = null; });   // allow a retry after a failure
  }
  return dbPromise;
}

const wrap = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });

async function store(name, mode = 'readonly') {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  return { tx, os: tx.objectStore(name) };
}

export async function saveRoast(roast) {
  const { tx, os } = await store('roasts', 'readwrite');
  os.put(roast);
  await done(tx);
  return roast;
}

// Pure part of updateRoast: a shallow merge of `patch` into the stored roast. The id never
// changes, and the reference flags are left to setReference(), which keeps them unique.
export function mergeRoastPatch(current, patch) {
  const { id: _id, reference: _reference, ...rest } = patch || {};
  return { ...current, ...rest };
}

// Read-modify-write of one roast in a single transaction, so an edit made from a screen that
// holds an older copy (for example, the detail page) never overwrites newer reference flags.
export async function updateRoast(id, patch) {
  const { tx, os } = await store('roasts', 'readwrite');
  const current = await wrap(os.get(id));
  if (!current) {
    tx.abort();
    throw new Error(`No roast with id ${id}`);
  }
  const next = mergeRoastPatch(current, patch);
  os.put(next);
  await done(tx);
  return next;
}

export async function getRoast(id) {
  const { os } = await store('roasts');
  return (await wrap(os.get(id))) ?? null;
}

// Newest first.
export async function listRoasts() {
  const { os } = await store('roasts');
  const all = await wrap(os.getAll());
  return all.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function deleteRoast(id) {
  const { tx, os } = await store('roasts', 'readwrite');
  os.delete(id);
  await done(tx);
}

// Sets the flags on one roast and clears the ones it replaces, in a single transaction.
export async function setReference(id, flags) {
  const { tx, os } = await store('roasts', 'readwrite');
  const all = await wrap(os.getAll());
  const changed = applyReferenceFlags(all, id, flags);
  for (const r of changed) os.put(r);
  await done(tx);
  return changed.find((r) => r.id === id) ?? all.find((r) => r.id === id);
}

export async function findReference(coffeeName) {
  return pickReference(await listRoasts(), coffeeName);
}

export async function getMeta(key) {
  const { os } = await store('meta');
  const row = await wrap(os.get(key));
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  const { tx, os } = await store('meta', 'readwrite');
  os.put({ key, value });
  await done(tx);
}
