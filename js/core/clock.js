// 1 Hz tick driven by a monotonic clock, not by counting timer callbacks.
// If the page was throttled or hidden, the next poll emits every tick it missed.
//
//   const clock = createClock({ speed: 1 });
//   const off = clock.onTick((t, { missed }) => { ... });
//   clock.start();          // emits tick 0 straight away
//
// `missed` is true for ticks emitted late in a catch-up batch (every tick of the batch
// except the last). A camera source has no reading for those seconds, so they are gaps.
// A simulator can ignore the flag.
//
// now, setInterval and clearInterval are injectable so tests need no real waiting.

export function createClock({
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setInterval: setTimer = (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: clearTimer = (id) => globalThis.clearInterval(id),
  speed = 1,
  pollMs = 200,
} = {}) {
  const listeners = new Set();
  let timer = null;
  let running = false;
  let baseElapsed = 0;   // seconds of roast time accumulated up to baseNow
  let baseNow = 0;       // real ms when baseElapsed was taken
  let lastTick = -1;

  // Poll often enough that fast-forwarded seconds are not bunched together.
  const period = () => Math.max(20, Math.min(pollMs, 500 / speed));

  const elapsed = () => (running ? baseElapsed + ((now() - baseNow) / 1000) * speed : baseElapsed);

  function emit() {
    const target = Math.floor(elapsed());
    const first = lastTick + 1;
    for (let t = first; t <= target; t++) {
      lastTick = t;
      const missed = t < target;
      for (const fn of [...listeners]) fn(t, { missed });
    }
  }

  function arm() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(emit, period());
  }

  return {
    get speed() { return speed; },
    get running() { return running; },
    get lastTick() { return lastTick; },
    elapsed,

    onTick(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    start() {
      if (running) return;
      running = true;
      baseNow = now();
      arm();
      emit();
    },

    // Keeps elapsed time where it is; start() continues from there.
    stop() {
      if (!running) return;
      baseElapsed = elapsed();
      running = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },

    // Changes speed without a jump in elapsed time.
    setSpeed(next) {
      if (!(next > 0)) throw new RangeError('speed must be positive');
      if (running) {
        baseElapsed = elapsed();
        baseNow = now();
      }
      speed = next;
      if (running) arm();
    },

    // Manual poll, for the caller to use when the page becomes visible again.
    poll: emit,
  };
}
