// One-off: bake a reusable FIRE finisher clip (doodle fighter -> pikaffects Explode).
// Output: assets/finishers/fire.mp4  (served statically; reused across every instance, no fal at demo time)
//   node tools/gen-fire-finisher.mjs
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAL_KEY = (readFileSync(join(ROOT, '.env'), 'utf8').match(/FAL_KEY=(.+)/) || [])[1]?.trim();
if (!FAL_KEY) throw new Error('FAL_KEY missing in .env');
const H = { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function falRun(model, input, label) {
  console.log(`[${label}] submitting ${model} ...`);
  let r = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers: H, body: JSON.stringify(input) });
  if (!r.ok) throw new Error(`${label} submit ${r.status}: ${await r.text()}`);
  const { status_url, response_url } = await r.json();
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const s = await (await fetch(status_url, { headers: H })).json();
    if (i % 5 === 0) console.log(`[${label}] ${s.status} (${i * 2}s)`);
    if (s.status === 'COMPLETED') {
      const res = await fetch(response_url, { headers: H });
      if (!res.ok) throw new Error(`${label} result ${res.status}: ${await res.text()}`);
      return res.json();
    }
    if (s.status === 'FAILED' || s.status === 'ERROR') throw new Error(`${label} failed: ${JSON.stringify(s)}`);
  }
  throw new Error(`${label} timed out`);
}

const SOURCE_PROMPT =
  'a single full-body hand-drawn black marker doodle of a cute round cartoon fighter character ' +
  'standing facing forward, simple confident ink outline with solid flat-color fills, childlike sticker style, ' +
  'centered with margin, on a warm cream paper background, no text, no extra objects';
const EXPLODE_PROMPT =
  'the doodle fighter is engulfed in a fiery orange explosion and bursts into ash, embers and smoke — ' +
  'dramatic knockout finisher. Keep the warm paper background and hand-drawn marker-doodle art style; ' +
  'do not add realistic detail.';

(async () => {
  const t2i = await falRun('fal-ai/recraft/v3/text-to-image',
    { prompt: SOURCE_PROMPT, style: 'digital_illustration', image_size: 'square_hd' }, 'source');
  const imageUrl = t2i.images?.[0]?.url;
  if (!imageUrl) throw new Error('no source image url: ' + JSON.stringify(t2i).slice(0, 200));
  console.log('[source] image:', imageUrl);

  const pika = await falRun('fal-ai/pika/v1.5/pikaffects',
    { image_url: imageUrl, pikaffect: 'Explode', prompt: EXPLODE_PROMPT, negative_prompt: 'realistic, photo, 3d render, text, watermark' }, 'pikaffect');
  const videoUrl = pika.video?.url || pika.video_url;
  if (!videoUrl) throw new Error('no video url: ' + JSON.stringify(pika).slice(0, 300));
  console.log('[pikaffect] video:', videoUrl);

  const outDir = join(ROOT, 'assets', 'finishers');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'fire.mp4');
  const dl = await fetch(videoUrl);
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  await new Promise((res, rej) => {
    const ws = createWriteStream(out);
    Readable.fromWeb(dl.body).pipe(ws).on('finish', res).on('error', rej);
  });
  console.log('\nDONE -> assets/finishers/fire.mp4');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
