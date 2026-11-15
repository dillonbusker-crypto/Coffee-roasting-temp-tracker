// Screen Wake Lock: held from Start to the end of the roast, re-acquired when the page
// becomes visible again (the browser drops the lock whenever the page is hidden).

export function createWakeLock() {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  let sentinel = null;
  let wanted = false;

  async function request() {
    if (!supported || !wanted || sentinel || document.visibilityState !== 'visible') return;
    try {
      const s = await navigator.wakeLock.request('screen');
      sentinel = s;
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
    } catch {
      sentinel = null;   // denied (low battery, no gesture): the Setup warning covers the user
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (wanted && document.visibilityState === 'visible') request();
    });
  }

  return {
    supported,
    get active() { return !!sentinel; },
    async acquire() {
      wanted = true;
      await request();
      return !!sentinel;
    },
    async release() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      try { if (s) await s.release(); } catch { /* already released */ }
    },
  };
}
