import {execFileSync} from 'node:child_process';
import {mkdirSync, unlinkSync, writeFileSync} from 'node:fs';

const clips = [
  ['intro', 'TesselArk connects business records, review work, and local GST preparation in one scoped workspace.'],
  ['overview', 'Start with a clear picture of sales, purchases, and the work waiting for review.'],
  ['orders', 'Follow an order through partial fulfilment, linked invoices, and stock movement.'],
  ['invoice', 'Compare entered tax with reviewed item policies, then record the accountant decision.'],
  ['evidence', 'Keep the source file, its version, and the review decision connected.'],
  ['tasks', 'Assign period work, complete the checklist, and close only with independently reviewed evidence.'],
  ['gst', 'Match supplier evidence before marking input tax credit eligible. Every amount stays tied to its period.'],
  ['sandbox', 'Practice statutory document lifecycles in a synthetic sandbox, without making a government submission.'],
  ['outro', 'TesselArk. See the work behind every number.'],
];
const sceneSeconds = [7, 8, 8, 8, 8, 8, 8, 8, 6];
const stamp = (seconds) => {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3600000);
  const minutes = Math.floor(millis / 60000) % 60;
  const secs = Math.floor(millis / 1000) % 60;
  const ms = millis % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

mkdirSync('public/audio', {recursive: true});
mkdirSync('out', {recursive: true});
let sceneStart = 0;
const captions = [];
clips.forEach(([name, line], index) => {
  const aiff = `public/audio/${name}.aiff`;
  const mp3 = `public/audio/${name}.mp3`;
  execFileSync('say', ['-v', 'Aman (English (India))', '-r', '183', '-o', aiff, line]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', aiff, '-codec:a', 'libmp3lame', '-qscale:a', '3', mp3]);
  unlinkSync(aiff);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', mp3], {encoding: 'utf8'}).trim());
  const narrationStart = sceneStart + (index === 0 ? 0.4 : 0.6);
  captions.push(`${index + 1}\n${stamp(narrationStart)} --> ${stamp(narrationStart + duration)}\n${line}\n`);
  sceneStart += sceneSeconds[index];
  console.log(`${name}: ${duration.toFixed(2)}s`);
});
writeFileSync('out/TesselArk-Product-Demo.srt', captions.join('\n'));
