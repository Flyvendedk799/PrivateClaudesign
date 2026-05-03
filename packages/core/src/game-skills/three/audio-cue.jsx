// when_to_use: One-shot SFX cues for game events (jump, hit, coin, score).
// Wraps Web Audio so playback is gated until first user input (autoplay
// policy) and respects `window.__game.config.startMuted`. Synthesises tiny
// procedural SFX so the game has audio even before any .wav file lands.

const EnvelopeShapes = {
  pop: { attack: 0.005, decay: 0.08, type: 'square' },
  zap: { attack: 0.001, decay: 0.15, type: 'sawtooth' },
  thud: { attack: 0.005, decay: 0.18, type: 'sine' },
  blip: { attack: 0.003, decay: 0.05, type: 'triangle' },
};

export function createAudio() {
  let ctx = null;
  let muted = window.__game?.config?.startMuted ?? false;
  const buffers = new Map();

  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  function unlock() {
    if (!ctx) ensureCtx();
    if (ctx.state === 'suspended') void ctx.resume();
  }
  // Autoplay-policy: arm on first user gesture
  ['pointerdown', 'keydown'].forEach((evt) => window.addEventListener(evt, unlock, { once: true }));

  return {
    setMuted(v) {
      muted = v;
    },
    /** Procedural cue — instant, no asset needed. */
    cue(name, freq = 440) {
      if (muted) return;
      const c = ensureCtx();
      if (c.state === 'suspended') return;
      const env = EnvelopeShapes[name] ?? EnvelopeShapes.blip;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = env.type;
      osc.frequency.setValueAtTime(freq, c.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, freq * 0.5),
        c.currentTime + env.decay,
      );
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, c.currentTime + env.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + env.attack + env.decay);
      osc.connect(gain).connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + env.attack + env.decay + 0.05);
    },
    /** Load + play a real sample (.wav / .ogg). Url is resolved against
     *  <base href> so `assets/audio/jump.wav` Just Works. */
    async play(url, volume = 0.5) {
      if (muted) return;
      const c = ensureCtx();
      if (!buffers.has(url)) {
        const resp = await fetch(url);
        const arr = await resp.arrayBuffer();
        buffers.set(url, await c.decodeAudioData(arr));
      }
      const src = c.createBufferSource();
      src.buffer = buffers.get(url);
      const gain = c.createGain();
      gain.gain.value = volume;
      src.connect(gain).connect(c.destination);
      src.start();
    },
  };
}

// Usage:
//   const audio = createAudio();
//   onCoinPickup(() => audio.cue('blip', 880));
//   onHit(() => audio.play('assets/audio/hit.wav'));
