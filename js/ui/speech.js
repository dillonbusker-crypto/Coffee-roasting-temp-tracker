// Spoken cues with a beep fallback.
//
// iOS blocks audio until a touch, so unlock() must run synchronously inside the Start tap:
// it resumes (or creates) the AudioContext and speaks a near-silent utterance.
// Cues are never queued: a new cue cancels whatever is still speaking, and a normal cue
// never cuts off a critical one that is still being said.

const WORDS_PER_SEC = 2.6;

export function createSpeech({ now = () => Date.now() } = {}) {
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  const hasUtterance = typeof SpeechSynthesisUtterance !== 'undefined';
  let audio = null;
  let current = null;          // { priority, until }
  const log = [];              // recent say() outcomes, for debugging and tests

  function ctx() {
    if (audio) return audio;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (AC) {
      try { audio = new AC(); } catch { audio = null; }
    }
    return audio;
  }

  function note(text, how) {
    log.push({ text, how });
    if (log.length > 50) log.shift();
  }

  function unlock() {
    const a = ctx();
    if (a) {
      try {
        if (a.state === 'suspended') a.resume().catch(() => {});
        const buf = a.createBuffer(1, 1, 22050);
        const src = a.createBufferSource();
        src.buffer = buf;
        src.connect(a.destination);
        src.start(0);
      } catch { /* the beep fallback just stays quiet */ }
    }
    if (synth && hasUtterance) {
      try {
        const u = new SpeechSynthesisUtterance('.');
        u.volume = 0.01;
        synth.speak(u);
      } catch { /* speech stays unavailable */ }
    }
  }

  // count short beeps, 880 Hz.
  function beep(count = 1) {
    const a = ctx();
    if (!a) return;
    try {
      if (a.state === 'suspended') a.resume().catch(() => {});
      const t0 = a.currentTime;
      for (let i = 0; i < count; i++) {
        const osc = a.createOscillator();
        const gain = a.createGain();
        const start = t0 + i * 0.22;
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
        osc.connect(gain);
        gain.connect(a.destination);
        osc.start(start);
        osc.stop(start + 0.18);
      }
    } catch { /* ignore */ }
  }

  // priority: 'critical' | 'normal'. silent: beep only (fast demo speeds).
  function say(text, { priority = 'normal', silent = false } = {}) {
    const critical = priority === 'critical';
    if (silent || !synth || !hasUtterance) {
      beep(critical ? 2 : 1);
      note(text, 'beep');
      return 'beep';
    }
    const t = now();
    if (current && t < current.until) {
      if (current.priority === 'critical' && !critical) {
        note(text, 'skipped');
        return 'skipped';
      }
    }
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1.05;
      u.onerror = (e) => {
        if (e && (e.error === 'canceled' || e.error === 'interrupted')) return;
        beep(critical ? 2 : 1);
      };
      const words = text.trim().split(/\s+/).length;
      current = { priority, until: t + (words / WORDS_PER_SEC) * 1000 + 400 };
      synth.speak(u);
      note(text, 'speech');
      return 'speech';
    } catch {
      beep(critical ? 2 : 1);
      note(text, 'beep');
      return 'beep';
    }
  }

  function stop() {
    current = null;
    try { synth && synth.cancel(); } catch { /* ignore */ }
  }

  return { unlock, say, beep, stop, log, get supported() { return !!(synth && hasUtterance); } };
}
