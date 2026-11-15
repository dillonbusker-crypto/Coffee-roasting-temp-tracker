// The interrupted-roast draft: a recoverable roast record kept in the meta store while a
// roast runs (written every 10 s by the controller) and cleared on save or discard.

import { getMeta, setMeta } from '../store/db.js';

const KEY = 'draft';

export function saveDraft(record) {
  return setMeta(KEY, { savedAt: new Date().toISOString(), record });
}

export async function loadDraft() {
  try {
    const d = await getMeta(KEY);
    return d && d.record && Array.isArray(d.record.readings) ? d : null;
  } catch {
    return null;
  }
}

export function clearDraft() {
  return setMeta(KEY, null).catch(() => {});
}
