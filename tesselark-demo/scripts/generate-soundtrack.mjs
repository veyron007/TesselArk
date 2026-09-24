import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

// A small original ambient bed keeps the export self-contained and licence-free.
const sampleRate = 22050;
const seconds = 69;
const samples = sampleRate * seconds;
const pcm = Buffer.alloc(44 + samples * 4);
pcm.write('RIFF', 0);
pcm.writeUInt32LE(pcm.length - 8, 4);
pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(sampleRate, 24);
pcm.writeUInt32LE(sampleRate * 4, 28);
pcm.writeUInt16LE(4, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(samples * 4, 40);

const chords = [
  [50, 54, 57, 61, 64], // Dmaj9
  [47, 50, 54, 57, 61], // Bm9
  [43, 47, 50, 54, 57], // Gmaj9
  [45, 49, 52, 57, 59], // Aadd9
];
const frequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
const fade = (time) => Math.min(1, time / 2, (seconds - time) / 3);
const sine = (phase) => Math.sin(phase * Math.PI * 2);

for (let index = 0; index < samples; index++) {
  const time = index / sampleRate;
  const chord = chords[Math.floor(time / 8) % chords.length];
  const chordTime = time % 8;
  const crossfade = Math.min(1, chordTime / 1.4);
  const previous = chords[(Math.floor(time / 8) + chords.length - 1) % chords.length];
  let pad = 0;
  for (let note = 0; note < chord.length; note++) {
    const current = frequency(chord[note]);
    const old = frequency(previous[note]);
    const motion = 0.84 + 0.16 * sine(time * 0.09 + note * 0.12);
    pad += motion * (crossfade * (sine(time * current) + 0.12 * sine(time * current * 2))
      + (1 - crossfade) * (sine(time * old) + 0.12 * sine(time * old * 2)));
  }
  pad *= 0.012;

  const beat = Math.floor(time / 0.8);
  const pluckTime = time % 0.8;
  const pluckNote = chord[[0, 2, 4, 2, 1, 3, 4, 3][beat % 8]] + 12;
  const pluck = Math.exp(-pluckTime * 7.2)
    * (sine(pluckTime * frequency(pluckNote)) + 0.27 * sine(pluckTime * frequency(pluckNote) * 2))
    * 0.032;
  const root = sine(time * frequency(chord[0] - 12)) * 0.012;
  const sectionTime = time % 8;
  const shimmer = sectionTime < 1.8
    ? Math.exp(-sectionTime * 2.5) * sine(sectionTime * frequency(chord[4] + 12)) * 0.015
    : 0;
  const base = (pad + pluck + root + shimmer) * fade(time);
  const pan = beat % 2 ? 0.96 : 1.04;
  const left = Math.max(-1, Math.min(1, base * pan));
  const right = Math.max(-1, Math.min(1, base / pan));
  pcm.writeInt16LE(Math.round(left * 32767), 44 + index * 4);
  pcm.writeInt16LE(Math.round(right * 32767), 46 + index * 4);
}

const wav = 'public/audio/original-score.wav';
const mp3 = 'public/audio/original-score.mp3';
writeFileSync(wav, pcm);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wav, '-codec:a', 'libmp3lame', '-qscale:a', '3', mp3]);
console.log(`Created ${mp3}`);
