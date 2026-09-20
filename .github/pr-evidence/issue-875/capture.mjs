import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium, firefox } from 'playwright';

const repo = process.env.BRACCATO_REPO ?? '/tmp/braccato-875';
const output = new URL('./screenshots/', import.meta.url).pathname;
const beforeRef = '2a3ce9c';
const afterRef = 'f01f88c';
const sourcePath = 'packages/core/src/styles/lyrics.css';
const beforeCSS = execFileSync('git', ['show', `${beforeRef}:${sourcePath}`], { cwd: repo, encoding: 'utf8' });
const afterCSS = execFileSync('git', ['show', `${afterRef}:${sourcePath}`], { cwd: repo, encoding: 'utf8' });
const variables = await readFile(`${repo}/packages/core/dist/styles/variables.css`, 'utf8');
await mkdir(output, { recursive: true });

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/packages/core/dist/')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(`${repo}${req.url}`, 'utf8'));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const engine of [firefox, chromium]) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1380, height: 1000 }, deviceScaleFactor: 1 });
      await page.goto(url);
      const browserName = engine === firefox ? 'Firefox' : 'Chromium';
      await page.addStyleTag({ content: `
        * { box-sizing: border-box; }
        body { margin: 0; padding: 32px; color: #ecedf1; background: #101116;
          font: 15px/1.5 "Noto Sans", sans-serif; }
        h1 { font-size: 27px; margin: 0 0 8px; letter-spacing: -.4px; }
        p { color: #b9beca; margin: 0 0 22px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        article { background: #191b22; border: 1px solid #363944; border-radius: 10px; overflow: hidden; }
        h2 { font-size: 18px; margin: 0; padding: 16px 20px; border-bottom: 1px solid #363944; }
        h2 span { font: 13px monospace; color: #b9beca; margin-left: 10px; }
        .case { padding: 18px 20px 16px; }
        .case + .case { border-top: 1px solid #363944; }
        h3 { font-size: 13px; color: #aeb6c6; font-weight: 500; margin: 0 0 10px; }
        iframe { display: block; border: 1px solid #45404a; height: 258px; background: #2d222b; }
        .readout { margin-top: 12px; color: #d3d7e1; font: 13px/1.6 monospace; }
        .fail { color: #ffaeae; } .pass { color: #a4e8b5; }
        footer { color: #aeb6c6; font-size: 12px; margin-top: 20px; }
      ` });
      await page.evaluate(({ browserName, version, beforeRef, afterRef }) => {
        const el = (tag, text, parent) => {
          const node = document.createElement(tag);
          if (text) node.textContent = text;
          parent.append(node);
          return node;
        };
        el('h1', `${browserName} ${version} · timed romanization highlights`, document.body);
        el('p', 'Before and after the CSS fix · same renderer, text, theme and paused playback at 6.0 seconds', document.body);
        const grid = el('div', '', document.body);
        grid.className = 'grid';
        for (const [state, ref] of [['before', beforeRef], ['after', afterRef]]) {
          const card = el('article', '', grid);
          const title = el('h2', state === 'before' ? 'Before' : 'After', card);
          el('span', ref, title);
          for (const width of [600, 280]) {
            const section = el('section', '', card);
            section.className = 'case';
            el('h3', `${width === 600 ? 'Wide' : 'Narrow'} lyrics view · ${width}px`, section);
            const frame = el('iframe', '', section);
            frame.name = `${state}-${width}`;
            frame.src = '/';
            frame.style.width = `${width + 2}px`;
            const readout = el('div', '', section);
            readout.id = `readout-${state}-${width}`;
            readout.className = 'readout';
          }
        }
        el('footer', 'Captured from the live Braccato renderer in Playwright. Widths are measured with getBoundingClientRect(). No image editing.', document.body);
      }, { browserName, version: browser.version(), beforeRef, afterRef });

      for (const state of ['before', 'after']) {
        for (const width of [600, 280]) {
          const frame = await (await page.locator(`iframe[name="${state}-${width}"]`).elementHandle()).contentFrame();
          await frame.waitForURL(url + '/');
          await frame.waitForLoadState();
          await frame.addStyleTag({ content: variables + (state === 'before' ? beforeCSS : afterCSS) + `
            body { margin: 0; padding: 8px; color: white; background: #2d222b; }
            :root { --blyrics-font-size: 30px; --blyrics-translated-font-size: 20px;
              --blyrics-padding: 14px; --blyrics-scale: 1; --blyrics-active-scale: 1;
              --blyrics-animate-line-scale: 0; --blyrics-animate-word-wobble: 0;
              --blyrics-animate-highlight-glow: 0; --blyrics-animate-decoration-entry: 0;
              --blyrics-animate-scroll: 0; }
            .blyrics-container { padding-top: 0; }
          ` });
          await frame.evaluate(async () => {
            const { createLyricsRenderer, injectRomanization, injectTranslation } =
              await import('/packages/core/dist/index.js');
            const mount = document.createElement('main');
            mount.style.height = '240px';
            mount.style.overflow = 'hidden';
            document.body.append(mount);
            const renderer = createLyricsRenderer({ document, window, mount,
              host: { getScrollElement: () => mount } });
            renderer.setLyrics([
              { words: '響く歌声', startTimeMs: 0, durationMs: 12000,
                parts: [{ words: '響く歌声', startTimeMs: 0, durationMs: 4000 }] },
              { words: '次のフレーズ', startTimeMs: 12000, durationMs: 8000,
                parts: [{ words: '次のフレーズ', startTimeMs: 12000, durationMs: 4000 }] },
            ]);
            const line = renderer.lines[0];
            const romanization = 'kimi no koe ga shizuka na yoru ni hibiku';
            injectRomanization(document, line.lyricElement, line, romanization,
              [{ words: romanization, startTimeMs: 0, durationMs: 4000 }]);
            injectTranslation(document, line.lyricElement, 'Your voice echoes through the quiet night.');
            await document.fonts.ready;
            renderer.relayout();
            renderer.tick(6, { isPlaying: false, smoothScroll: false });
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            renderer.tick(6, { isPlaying: false, smoothScroll: false });
            window.evidenceRenderer = renderer;
          });
          // Allow the entry animation to settle while playback remains paused.
          await frame.waitForTimeout(500);
          const metrics = await frame.evaluate(() => {
            const roman = document.querySelector('.blyrics--romanized');
            const content = roman.querySelector('.blyrics-bidi-run:not(.blyrics-highlight-run)').getBoundingClientRect();
            const highlight = roman.querySelector('.blyrics-highlight-run').getBoundingClientRect();
            const parts = window.evidenceRenderer.lines[0].parts.filter(p => roman.contains(p.lyricElement));
            const maxDelta = Math.max(...parts.map(part => {
              const a = part.lyricElement.getBoundingClientRect();
              const b = part.highlightElement.getBoundingClientRect();
              return Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(a[key] - b[key])));
            }));
            return { contentWidth: content.width, highlightWidth: highlight.width,
              contentHeight: content.height, highlightHeight: highlight.height, maxDelta,
              activeHighlights: parts.filter(p => Number(getComputedStyle(p.highlightElement).opacity) > 0).length };
          });
          assert.ok(metrics.activeHighlights > 0, 'Screenshot must show active highlights');
          if (state === 'after' || engine === chromium) {
            assert.ok(metrics.highlightWidth > 0);
            assert.ok(metrics.maxDelta < 0.2, 'Highlights must align with visible text');
          } else {
            assert.equal(metrics.highlightWidth, 0, 'Firefox must reproduce the original defect');
          }
          await page.evaluate(({ state, width, metrics }) => {
            const readout = document.getElementById(`readout-${state}-${width}`);
            const pass = metrics.maxDelta < .2;
            readout.classList.add(pass ? 'pass' : 'fail');
            readout.textContent = `Text: ${metrics.contentWidth.toFixed(2)}px · Highlight: ${metrics.highlightWidth.toFixed(2)}px\n` +
              (pass ? 'Word positions align' : 'Highlight collapses and wraps over following content');
            readout.style.whiteSpace = 'pre-line';
          }, { state, width, metrics });
          results.push({ browser: browserName, version: browser.version(), state, width, ...metrics });
        }
      }
      await page.screenshot({ path: `${output}/${engine.name()}-before-after.png`, fullPage: true });
    } finally {
      await browser.close();
    }
  }
  await writeFile(`${output}/measurements.json`, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  server.close();
}
