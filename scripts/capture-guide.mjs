#!/usr/bin/env node
/**
 * Capture Guide screenshots for the in-app Guide.
 *
 * Viewport 1280×800, light theme, deviceScaleFactor 2, then downscale 50%
 * and write WebP under assets/guide/ (target <200KB each).
 *
 * Playwright is a capture-time tool, not a runtime dependency:
 *   npm i --no-save --no-package-lock playwright
 *   node scripts/capture-guide.mjs
 *
 * Uses the system Chrome if present so Chromium does not need downloading.
 * Starts its own server on an ephemeral port unless GUIDE_BASE is set.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'assets', 'guide');
const MAX_BYTES = 200 * 1024;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Capture-only (do not add it to package.json):\n  npm i --no-save --no-package-lock playwright\n  node scripts/capture-guide.mjs');
  process.exit(1);
}

const DEMO_BODY = 'London Tech Week is adding two community stages this year, aimed at first-time attendees and local meetups rather than the main expo floor.\n\nOrganisers say the stages will run workshops from Shoreditch.js, Women Who Code London and Rust London — not keynotes. If you run a meetup, the call for sessions closes Friday.';

const SEED_EMPTY = {
  topics: [],
  researchedAt: '',
  week: { mon: null, wed: null, fri: null },
  posts: {},
  filter: 'all',
  customs: 0,
  log: [],
  chat: [],
  analytics: []
};

const TOPIC = {
  id: 'guide-mon',
  title: 'London Tech Week adds two community stages',
  category: 'events',
  categoryLabel: 'Events',
  date: '2026-10-21',
  facts: [
    { text: 'London Tech Week is adding two community stages this year.', source: 'London Tech Week', date: '2026-10-21', url: 'https://londontechweek.example/stages' },
    { text: 'Workshops from Shoreditch.js, Women Who Code London and Rust London.', source: 'London Tech Week', date: '2026-10-21', url: 'https://londontechweek.example/stages' },
    { text: 'Call for sessions closes Friday.', source: 'London Tech Week', date: '2026-10-21' }
  ],
  bestDay: 'mon',
  trusted: true,
  confirmed: true,
  whyItMatters: 'First-time attendees get a dedicated stage instead of the expo floor.'
};

const SEED_DRAFT = {
  topics: [TOPIC],
  researchedAt: '2026-10-21T10:00:00.000Z',
  week: { mon: TOPIC, wed: null, fri: null },
  posts: {
    mon: {
      text: DEMO_BODY,
      headline: 'Two community stages',
      hashtags: ['LondonTechWeek', 'BuildInPublic'],
      visual: 'Workshop tables at a community stage',
      scene: 'workspace',
      toCheck: [],
      verified: true,
      lint: [],
      sources: [{ source: 'London Tech Week', url: 'https://londontechweek.example/stages' }],
      tagline: 'Connecting London\'s tech builders',
      updated: Date.parse('2026-10-21T18:12:00Z')
    }
  },
  filter: 'all',
  customs: 0,
  log: [{ t: Date.parse('2026-10-21T18:12:00Z'), text: 'Wrote Monday from London Tech Week stages.' }],
  chat: [],
  analytics: []
};

function chromePath() {
  return process.env.CHROME
    || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/local/bin/google-chrome');
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(cmd + ' exited ' + code + (err ? '\n' + err.slice(-800) : '')));
    });
  });
}

async function encodeWebp(pngPath, webpPath) {
  const qualities = [82, 72, 62, 52, 42];
  let lastSize = Infinity;
  for (const q of qualities) {
    await run('ffmpeg', [
      '-y', '-i', pngPath,
      '-vf', 'scale=iw/2:ih/2',
      '-c:v', 'libwebp', '-quality', String(q), '-compression_level', '6',
      webpPath
    ]);
    lastSize = (await stat(webpPath)).size;
    if (lastSize <= MAX_BYTES) return lastSize;
  }
  throw new Error(webpPath + ' is still ' + lastSize + ' bytes after compression');
}

async function unionBox(page, selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const boxes = [];
  for (const sel of list) {
    const handle = page.locator(sel).first();
    await handle.waitFor({ state: 'visible', timeout: 15000 });
    const box = await handle.boundingBox();
    if (box) boxes.push(box);
  }
  if (!boxes.length) throw new Error('No bounding box for ' + list.join(','));
  const x = Math.min(...boxes.map(b => b.x));
  const y = Math.min(...boxes.map(b => b.y));
  const r = Math.max(...boxes.map(b => b.x + b.width));
  const b = Math.max(...boxes.map(b => b.y + b.height));
  return { x, y, width: r - x, height: b - y };
}

async function screenshotToWebp(page, locator, webpPath, { pad = 8, outline } = {}) {
  if (outline) {
    await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.style.outline = '3px solid #ff5a1f';
      el.style.outlineOffset = '3px';
      el.style.boxShadow = 'none';
    }, outline);
  }
  const box = await unionBox(page, locator);
  if (!box) throw new Error('No bounding box for ' + webpPath);
  const clip = {
    x: Math.max(0, Math.floor(box.x - pad)),
    y: Math.max(0, Math.floor(box.y - pad)),
    width: Math.min(1280, Math.ceil(box.width + pad * 2)),
    height: Math.min(800, Math.ceil(box.height + pad * 2))
  };
  const tmp = await mkdtemp(join(tmpdir(), 'gp-guide-'));
  const pngPath = join(tmp, 'shot.png');
  try {
    await page.screenshot({ path: pngPath, type: 'png', clip, animations: 'disabled' });
    await encodeWebp(pngPath, webpPath);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  const size = (await stat(webpPath)).size;
  const mark = outline ? await markerPct(page, clip, outline) : null;
  return { size, clip, mark };
}

async function markerPct(page, clip, sel) {
  const box = await page.locator(sel).first().boundingBox();
  if (!box) return null;
  return {
    left: Number((((box.x + box.width / 2) - clip.x) / clip.width * 100).toFixed(1)),
    top: Number((((box.y + box.height / 2) - clip.y) / clip.height * 100).toFixed(1))
  };
}

async function openPage(browser, base, seed) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-GB'
  });
  await context.addInitScript(({ seed, theme }) => {
    localStorage.setItem('social-engine-theme', theme);
    localStorage.setItem('social-engine-v2', JSON.stringify(seed));
    document.documentElement.setAttribute('data-theme', theme);
  }, { seed, theme: 'light' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view-dash');
  await page.emulateMedia({ colorScheme: 'light' }).catch(() => {});
  await page.evaluate(() => document.fonts ? document.fonts.ready : null).catch(() => {});
  await page.waitForTimeout(700);
  return { context, page };
}

async function go(page, view) {
  await page.evaluate(v => {
    const btn = document.querySelector('.nav button[data-view="' + v + '"]');
    if (btn) btn.click();
  }, view);
  await page.waitForSelector('#view-' + view + ':not([hidden])');
  await page.waitForTimeout(250);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  let server;
  let base = process.env.GUIDE_BASE;
  if (!base) {
    server = createApp();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  const exe = chromePath();
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars']
  });
  const marks = {};
  try {
    const demo = await openPage(browser, base, SEED_EMPTY);

    await go(demo.page, 'dash');
    await demo.page.waitForSelector('#recentPosts tr');
    const dash = await screenshotToWebp(demo.page, '#view-dash', join(outDir, 'dashboard.webp'), { pad: 0 });
    console.log('dashboard.webp', dash.size);

    await go(demo.page, 'brand');
    await demo.page.waitForFunction(() => {
      const el = document.getElementById('brandName');
      return el && el.value && el.value.length > 2;
    });
    const brand = await screenshotToWebp(demo.page, ['#view-brand .page-h', '#view-brand .glass'], join(outDir, 'brand.webp'), { pad: 8 });
    console.log('brand.webp', brand.size);

    await go(demo.page, 'library');
    await demo.page.waitForSelector('#libraryPosts tr');
    const library = await screenshotToWebp(demo.page, '#view-library', join(outDir, 'library.webp'), { pad: 0 });
    console.log('library.webp', library.size);

    await go(demo.page, 'settings');
    await demo.page.waitForSelector('#theme');
    const settings = await screenshotToWebp(demo.page, '#view-settings', join(outDir, 'settings.webp'), { pad: 0 });
    console.log('settings.webp', settings.size);
    await demo.context.close();

    const studio = await openPage(browser, base, SEED_DRAFT);
    await go(studio.page, 'studio');
    await studio.page.waitForSelector('#posts .post, #posts article, #previewBody');
    await studio.page.locator('.studio-split').scrollIntoViewIfNeeded();
    await studio.page.evaluate(() => {
      const ideas = document.querySelector('#view-studio .studio-main .blk:nth-of-type(2)');
      if (ideas) ideas.style.display = 'none';
      const empty = document.querySelector('#ideas');
      if (empty) empty.style.display = 'none';
    });
    await studio.page.waitForTimeout(200);
    const studioShot = await screenshotToWebp(studio.page, '.studio-split', join(outDir, 'studio.webp'), {
      pad: 4,
      outline: '#writeWeek'
    });
    marks.studio = studioShot.mark;
    console.log('studio.webp', studioShot.size, 'mark', studioShot.mark);

    await studio.page.evaluate(() => {
      const el = document.getElementById('writeWeek');
      if (el) { el.style.outline = ''; el.style.outlineOffset = ''; }
    });
    const li = await screenshotToWebp(studio.page, '#studioPreview', join(outDir, 'linkedin.webp'), {
      pad: 10,
      outline: '#previewLi'
    });
    marks.linkedin = li.mark;
    console.log('linkedin.webp', li.size, 'mark', li.mark);

    await studio.page.evaluate(() => {
      const el = document.getElementById('previewLi');
      if (el) { el.style.outline = ''; el.style.outlineOffset = ''; }
    });
    await studio.page.click('#previewIg');
    await studio.page.waitForSelector('#igDialog:not([hidden])');
    await studio.page.waitForFunction(() => {
      const mode = document.getElementById('igMode');
      return mode && /Open in Instagram|dry-run|API/i.test(mode.textContent || '');
    });
    await studio.page.evaluate(() => {
      ['igRequestLabel', 'igRequests', 'igImageNote'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      });
      const lab = document.querySelector('label[for="igImageUrl"]');
      if (lab) lab.hidden = true;
      const input = document.getElementById('igImageUrl');
      if (input) {
        input.hidden = true;
        const hint = input.nextElementSibling;
        if (hint && hint.classList.contains('hint')) hint.hidden = true;
      }
    });
    await studio.page.waitForTimeout(150);
    const ig = await screenshotToWebp(studio.page, '.ig-panel', join(outDir, 'instagram.webp'), {
      pad: 8,
      outline: '#igOpen'
    });
    marks.instagram = ig.mark;
    console.log('instagram.webp', ig.size, 'mark', ig.mark);

    await studio.context.close();
    await writeFile(join(outDir, 'markers.json'), JSON.stringify(marks, null, 2) + '\n');
    console.log('Wrote', outDir);
  } finally {
    await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
