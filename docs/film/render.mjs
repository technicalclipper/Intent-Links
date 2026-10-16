// Renders intentlink-film.html to an MP4 by stepping its render(t) frame by frame.
// Needs Chrome, ffmpeg and puppeteer-core (not a repo dependency):
//   npm i --no-save puppeteer-core && node docs/film/render.mjs docs/film/intentlink-film.html out.mp4
//   node docs/film/render.mjs docs/film/intentlink-film.html stills/ --stills 4.9,11.4,21.5
import puppeteer from 'puppeteer-core';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const [,, src, out, ...rest] = process.argv;
const arg = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const stills = arg('--stills');
const fps = Number(arg('--fps', 60));
const DUR = 25;

const wrapped = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script>window.__CAPTURE=true</script></head><body>${readFileSync(src, 'utf8')}</body></html>`;
const tmp = path.join(os.tmpdir(), 'intentlink-film-capture.html');
writeFileSync(tmp, wrapped);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  protocolTimeout: 120000,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--disable-gpu-vsync', '--font-render-hinting=none'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('file://' + tmp, { waitUntil: 'load', timeout: 120000 });
await page.evaluate(() => window.__ready);
const fontsOk = await page.evaluate(() => document.fonts.check('500 20px "IBM Plex Mono"') && document.fonts.check('italic 300 20px "IBM Plex Sans"'));
console.log('fonts loaded:', fontsOk);
// Fallback faces would silently change every measured layout; refuse rather
// than render a film that looks almost right.
if (!fontsOk) { await browser.close(); throw new Error('IBM Plex did not load - check the network and retry'); }

if (stills) {
  mkdirSync(out, { recursive: true });
  for (const t of stills.split(',').map(Number)) {
    await page.evaluate((t) => window.renderAt(t), t);
    await page.screenshot({ path: path.join(out, `t${t.toFixed(2)}.png`) });
  }
} else {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-tune', 'animation',
    '-movflags', '+faststart', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(DUR * fps);
  const t0 = Date.now();
  for (let f = 0; f < total; f++) {
    const t = f / fps;
    let buf;
    for (let attempt = 0; ; attempt++) {
      try {
        await page.evaluate((t) => window.renderAt(t), t);
        buf = await page.screenshot({ type: 'png' });   // lossless; slower, but no JPEG artefacts on hairlines
        break;
      } catch (err) {
        // A long capture occasionally drops one CDP call; the frame is a pure
        // function of t, so simply asking again is safe.
        if (attempt >= 3) throw err;
        console.log(`frame ${f}: retry after ${err.message}`);
      }
    }
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 120 === 0) console.log(`frame ${f}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('done', out);
}
await browser.close();
