/**
 * gameplan §E — one-shot script that synthesizes the starter audio
 * samples committed under `sfx/`, `music/`, `voice/`. Re-running this
 * regenerates the bytes; the script itself is committed so future
 * contributors can audit + regenerate the bundle.
 *
 * Usage (from repo root):
 *   pnpm tsx packages/core/src/audio-bank/_generate-starter-samples.ts
 *
 * The samples are intentionally small (~0.1-0.3 s, 22050 Hz, 16-bit mono)
 * so the bundle stays tiny. Real Kenney CC0 packs are added on top
 * separately by ops; the manifest already names them.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 22050;

function writeWav(path: string, samples: Float32Array): void {
  const numSamples = samples.length;
  const dataBytes = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataBytes);
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(clamped * 0x7fff), 44 + i * 2);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
}

function envelope(t: number, dur: number): number {
  // Quick attack + exponential decay — typical SFX shape.
  const attack = Math.min(1, t / 0.005);
  const decay = Math.exp(-3 * (t / dur));
  return attack * decay;
}

function sine(freq: number, t: number): number {
  return Math.sin(2 * Math.PI * freq * t);
}

function noise(): number {
  return Math.random() * 2 - 1;
}

function clickChirp(durSec: number, startHz: number, endHz: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * durSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = startHz + (endHz - startHz) * (t / durSec);
    out[i] = sine(freq, t) * envelope(t, durSec) * 0.6;
  }
  return out;
}

function thudKick(durSec: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * durSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const freq = 80 * Math.exp(-12 * t);
    out[i] = (sine(freq, t) * 0.7 + noise() * 0.15) * envelope(t, durSec) * 0.7;
  }
  return out;
}

function coinPing(durSec: number): Float32Array {
  const n = Math.floor(SAMPLE_RATE * durSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const a = sine(880, t) * 0.5;
    const b = sine(1320, t) * 0.4;
    out[i] = (a + b) * envelope(t, durSec) * 0.55;
  }
  return out;
}

function sweepLoop(durSec: number): Float32Array {
  // Looping ambient pad — soft sine drone with a slow vibrato.
  const n = Math.floor(SAMPLE_RATE * durSec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const vibrato = sine(0.5, t) * 6;
    const v = sine(220 + vibrato, t) * 0.25 + sine(330 + vibrato, t) * 0.15;
    // Smooth fade-in / fade-out so the loop doesn't click.
    const fade = Math.min(1, t / 0.05) * Math.min(1, (durSec - t) / 0.05);
    out[i] = v * fade;
  }
  return out;
}

function blipMelody(durSec: number, notes: readonly number[]): Float32Array {
  const n = Math.floor(SAMPLE_RATE * durSec);
  const out = new Float32Array(n);
  const noteDur = durSec / notes.length;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const noteIdx = Math.min(notes.length - 1, Math.floor(t / noteDur));
    const noteT = t - noteIdx * noteDur;
    const freq = notes[noteIdx] ?? 440;
    out[i] = sine(freq, t) * envelope(noteT, noteDur) * 0.4;
  }
  return out;
}

const here = dirname(fileURLToPath(import.meta.url));

writeWav(join(here, 'sfx/click.wav'), clickChirp(0.08, 1200, 800));
writeWav(join(here, 'sfx/jump.wav'), clickChirp(0.18, 600, 1200));
writeWav(join(here, 'sfx/coin.wav'), coinPing(0.35));
writeWav(join(here, 'sfx/hit.wav'), thudKick(0.22));
writeWav(join(here, 'sfx/footstep.wav'), thudKick(0.08));
writeWav(join(here, 'sfx/laser.wav'), clickChirp(0.18, 2200, 400));
writeWav(join(here, 'sfx/explosion.wav'), thudKick(0.5));

writeWav(join(here, 'music/ambient_loop.wav'), sweepLoop(2.0));
writeWav(join(here, 'music/menu_jingle.wav'), blipMelody(1.2, [523, 659, 784, 1047]));

writeWav(join(here, 'voice/notify_chime.wav'), blipMelody(0.6, [659, 880]));

// biome-ignore lint/suspicious/noConsole: this file is a one-shot script run via tsx, not part of the runtime
console.log('Wrote starter audio samples to', here);
