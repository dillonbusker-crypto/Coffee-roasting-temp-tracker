// Saving and picking files. Nothing here knows about roasts.
//
//   saveFile({ filename, text, mime }) -> 'shared' | 'downloaded' | 'cancelled'
//   canShareFile(file)                 -> true where the share sheet can take a file (iPhone Safari)
//   downloadFile(filename, text, mime) -> starts a browser download (Blob + <a download>)
//   createFilePicker({ accept, onText }) -> { input, open() } a hidden file input; onText(text, file)
//
// On an iPhone the share sheet is how a file reaches Files, so saveFile prefers it when the
// browser allows it, and falls back to a download if sharing fails for any reason but the
// user cancelling.

export function makeFile(filename, text, mime) {
  return new File([text], filename, { type: mime });
}

export function canShareFile(file) {
  try {
    return typeof navigator !== 'undefined'
      && typeof navigator.share === 'function'
      && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [file] }) === true;
  } catch {
    return false;
  }
}

export function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function saveFile({ filename, text, mime, preferShare = true }) {
  const file = makeFile(filename, text, mime);
  if (preferShare && canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // Any other failure (for example the tap was too long ago): download instead.
    }
  }
  downloadFile(filename, text, mime);
  return 'downloaded';
}

export function createFilePicker({ accept = '', id, onText, onError }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  if (id) input.id = id;
  if (accept) input.accept = accept;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';   // picking the same file twice must still fire change
    if (!file) return;
    try {
      onText(await file.text(), file);
    } catch (err) {
      if (onError) onError(err);
    }
  });
  return { input, open: () => input.click() };
}
