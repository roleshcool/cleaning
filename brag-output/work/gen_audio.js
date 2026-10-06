// Procedural music + SFX for the brag video. No deps: raw PCM synthesis -> WAV.
const fs = require("fs");
const path = require("path");

const SR = 44100;
const OUT_DIR = path.join(__dirname, "audio");
fs.mkdirSync(OUT_DIR, { recursive: true });

function writeWav(filePath, samplesL, samplesR) {
  const n = samplesL.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample * 2; // stereo
  const dataSize = n * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // channels
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, samplesL[i]));
    const r = Math.max(-1, Math.min(1, samplesR[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * blockAlign);
    buf.writeInt16LE(Math.round(r * 32767), 44 + i * blockAlign + 2);
  }
  fs.writeFileSync(filePath, buf);
}

function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

function addAt(buf, chunk, startSec) {
  const start = Math.round(startSec * SR);
  for (let i = 0; i < chunk.length; i++) {
    const idx = start + i;
    if (idx >= 0 && idx < buf.length) buf[idx] += chunk[i];
  }
}

function adsr(i, n, attack, decay, sustainLevel, release) {
  const a = attack * SR, d = decay * SR, r = release * SR;
  if (i < a) return i / a;
  if (i < a + d) return 1 - (1 - sustainLevel) * ((i - a) / d);
  if (i > n - r) return sustainLevel * Math.max(0, (n - i) / r);
  return sustainLevel;
}

// Soft rounded tone: blend of sine + a little triangle for warmth.
function tone(freq, seconds, vol, attack = 0.01, decay = 0.08, sustain = 0.6, release = 0.15) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const sine = Math.sin(2 * Math.PI * freq * t);
    const tri = Math.asin(Math.sin(2 * Math.PI * freq * t)) * (2 / Math.PI);
    const env = adsr(i, n, attack, decay, sustain, release);
    out[i] = (sine * 0.7 + tri * 0.3) * env * vol;
  }
  return out;
}

function noiseBurst(seconds, vol, filterHzStart, filterHzEnd) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const cutoff = filterHzStart + (filterHzEnd - filterHzStart) * t;
    const alpha = Math.min(1, cutoff / (SR / 2));
    const white = Math.random() * 2 - 1;
    lp = lp + alpha * (white - lp);
    const env = Math.pow(1 - t, 1.5) * (t < 0.05 ? t / 0.05 : 1);
    out[i] = lp * env * vol;
  }
  return out;
}

function subKick(seconds, vol) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const freq = 90 * Math.exp(-t * 18) + 45;
    const env = Math.exp(-t * 10);
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * vol;
  }
  return out;
}

// ---- Background bed: soft arpeggiated chords, gentle sub pulse ----
// Total matches the final assembled video length (6 scenes joined with 0.3s crossfades,
// which eats 5*0.3=1.5s off the raw sum of scene durations).
const TOTAL = 19.0;
const bed = silence(TOTAL);

const BPM = 108;
const beat = 60 / BPM;
// Chord progression (Cmaj7 - Am7 - Fmaj7 - G), arpeggiated up, one chord per bar (4 beats)
const chords = [
  [261.63, 329.63, 392.0, 493.88],   // Cmaj7
  [220.0, 261.63, 329.63, 392.0],    // Am7
  [174.61, 220.0, 261.63, 349.23],   // Fmaj7
  [196.0, 246.94, 293.66, 392.0],    // G
];
let tcur = 0.3; // small lead-in
let barIdx = 0;
while (tcur < TOTAL - 0.5) {
  const chord = chords[barIdx % chords.length];
  for (let step = 0; step < 4; step++) {
    const noteT = tcur + step * beat;
    if (noteT > TOTAL - 0.3) break;
    const freq = chord[step % chord.length];
    const pluck = tone(freq, beat * 1.1, 0.05, 0.005, 0.05, 0.3, beat * 0.8);
    addAt(bed, pluck, noteT);
    // soft octave-up shimmer on the "and" of beat 1 and 3, playful without cluttering
    if (step === 0 || step === 2) {
      const shimmer = tone(freq * 2, beat * 0.6, 0.018, 0.005, 0.04, 0.2, beat * 0.4);
      addAt(bed, shimmer, noteT + beat * 0.5);
    }
  }
  // sub pulse on beat 1 and 3 of every bar for a "punchy, clean" default-tone feel
  addAt(bed, subKick(0.5, 0.12), tcur);
  addAt(bed, subKick(0.5, 0.08), tcur + beat * 2);
  tcur += beat * 4;
  barIdx++;
}

// ---- SFX layer, mixed softly under/around the bed at scene-cut timestamps ----
// Boundaries below are the crossfade START points in the final assembled video
// (see assemble.js), not the raw per-scene durations - the two diverge because
// each 0.3s crossfade eats into the running total.
const sfx = silence(TOTAL);
const cutTimes = [0.0, 2.2, 5.4, 9.1, 12.3, 16.0];
for (const ct of cutTimes) {
  addAt(sfx, noiseBurst(0.35, 0.22, 400, 3200), ct - 0.05);
}
// login "click" confirm just before the login scene ends
addAt(sfx, tone(880, 0.09, 0.12, 0.002, 0.02, 0.0, 0.06), 5.00);
addAt(sfx, tone(1320, 0.07, 0.08, 0.002, 0.02, 0.0, 0.05), 5.03);
// soft keystroke ticks while "typing" in the login scene (kept low, background texture)
const tickTimes = [2.75, 2.92, 3.08, 3.25, 3.41, 3.75, 3.92, 4.08, 4.25];
for (const tt of tickTimes) {
  addAt(sfx, tone(2400 + Math.random() * 400, 0.03, 0.035, 0.001, 0.01, 0.0, 0.02), tt);
}
// outro resolving chime (ascending, settles on the final beat)
addAt(sfx, tone(523.25, 0.6, 0.09, 0.01, 0.15, 0.4, 0.4), 16.6);
addAt(sfx, tone(659.25, 0.6, 0.09, 0.01, 0.15, 0.4, 0.4), 16.85);
addAt(sfx, tone(784.0, 1.0, 0.11, 0.01, 0.2, 0.5, 0.7), 17.1);

// Mix: bed a touch lower so effects sit "softly under" per the sound-design note, but
// effects themselves are already gentle so nothing spikes above the music.
const mixL = new Float32Array(Math.round(TOTAL * SR));
const mixR = new Float32Array(Math.round(TOTAL * SR));
for (let i = 0; i < mixL.length; i++) {
  const v = (bed[i] || 0) * 0.85 + (sfx[i] || 0) * 1.0;
  // gentle stereo width: right channel gets a hair of delay/detune via i-1 blend
  mixL[i] = v;
  mixR[i] = i > 6 ? v * 0.98 + (bed[i - 6] || 0) * 0.06 : v;
}

writeWav(path.join(OUT_DIR, "brag-audio.wav"), mixL, mixR);
console.log("wrote", path.join(OUT_DIR, "brag-audio.wav"), "duration", TOTAL);
