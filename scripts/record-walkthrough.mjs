#!/usr/bin/env node
/**
 * Record the in-app Guide walkthrough (Playwright recordVideo).
 *
 * 1280×720, light theme, demo data, no OpenAI key. Studio writing is mocked
 * with page.route. Playwright is capture-only — not a runtime dependency:
 *   npm i --no-save --no-package-lock playwright
 *   npx playwright install ffmpeg
 *   node scripts/record-walkthrough.mjs
 *
 * Writes assets/guide/walkthrough.mp4 + walkthrough.jpg (H.264, <8MB).
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'assets', 'guide');
const MAX_BYTES = 8 * 1024 * 1024;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Capture-only (do not add it to package.json):\n  npm i --no-save --no-package-lock playwright\n  node scripts/record-walkthrough.mjs');
  process.exit(1);
}

const DRAFT = 'London Tech Week is adding two community stages this year, aimed at first-time attendees and local meetups rather than the main expo floor.\n\nOrganisers say the stages will run workshops from Shoreditch.js, Women Who Code London and Rust London — not keynotes. If you run a meetup, the call for sessions closes Friday.';

const SEED = {
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

const POST_BODY = {
  post: DRAFT,
  headline: 'Two community stages',
  hashtags: ['LondonTechWeek', 'BuildInPublic'],
  visual: 'Workshop tables at a community stage',
  scene: 'workspace',
  toCheck: [],
  verified: true,
  lint: [],
  sources: [{ source: 'London Tech Week', url: 'https://londontechweek.example/stages' }]
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
      else reject(new Error(cmd + ' exited ' + code + (err ? '\n' + err.slice(-1200) : '')));
    });
  });
}

function sleep(page, ms) {
  return page.waitForTimeout(ms);
}

async function injectChrome(page) {
  await page.addStyleTag({ content: `
    html, body, button, a, input, textarea, select { cursor: none !important; }
    #gp-cursor {
      position: fixed; z-index: 2147483000; width: 12px; height: 12px; left: 640px; top: 360px;
      background: #0a0a0a; border: 2px solid #fff; border-radius: 50%;
      transform: translate(-50%, -50%); pointer-events: none;
    }
    #gp-ripple {
      position: fixed; z-index: 2147482999; width: 28px; height: 28px; left: 0; top: 0;
      border: 2px solid #ff5a1f; border-radius: 50%; pointer-events: none;
      transform: translate(-50%, -50%) scale(.35); opacity: 0;
    }
    #gp-ripple.on { animation: gp-rip .36s ease-out; }
    @keyframes gp-rip {
      from { opacity: 1; transform: translate(-50%, -50%) scale(.35); }
      to { opacity: 0; transform: translate(-50%, -50%) scale(1.55); }
    }
    #gp-cap {
      position: fixed; left: 20px; bottom: 20px; z-index: 2147482998;
      background: #fff; color: #0a0a0a; border: 1px solid #e4e4e7; border-radius: 8px;
      padding: 10px 14px; display: flex; gap: 10px; align-items: center;
      font: 500 15px/1.35 Inter, ui-sans-serif, system-ui, sans-serif;
      max-width: min(440px, 68vw);
    }
    #gp-cap[hidden] { display: none !important; }
    #gp-cap .n {
      width: 22px; height: 22px; background: #ff5a1f; color: #fff; border-radius: 6px;
      font: 600 12px/22px "JetBrains Mono", ui-monospace, monospace; text-align: center; flex: none;
    }
    #gp-card {
      position: fixed; inset: 0; z-index: 2147483646; background: #fff; color: #0a0a0a;
      display: grid; place-items: center; text-align: center; padding: 48px;
      font: 600 28px/1.3 Inter, ui-sans-serif, system-ui, sans-serif;
    }
    #gp-card[hidden] { display: none !important; }
    #gp-card .mark { width: 28px; height: 28px; background: #ff5a1f; border-radius: 8px; margin: 0 auto 18px; }
    #gp-card .sub { margin-top: 12px; font-size: 15px; font-weight: 400; color: #52525b; }
  ` });
  await page.evaluate(() => {
    if (document.getElementById('gp-cursor')) return;
    const cursor = document.createElement('div'); cursor.id = 'gp-cursor';
    const ripple = document.createElement('div'); ripple.id = 'gp-ripple';
    const cap = document.createElement('div'); cap.id = 'gp-cap'; cap.hidden = true;
    cap.innerHTML = '<span class="n"></span><span class="t"></span>';
    const card = document.createElement('div'); card.id = 'gp-card'; card.hidden = true;
    card.innerHTML = '<div><div class="mark"></div><div class="title"></div><div class="sub"></div></div>';
    document.body.append(cursor, ripple, cap, card);
    const video = document.querySelector('.guide-video');
    if (video) video.style.display = 'none';
  });
}

async function showCard(page, title, sub) {
  await page.evaluate(({ title, sub }) => {
    const card = document.getElementById('gp-card');
    card.querySelector('.title').textContent = title;
    card.querySelector('.sub').textContent = sub || '';
    card.hidden = false;
    document.getElementById('gp-cap').hidden = true;
  }, { title, sub });
}

async function hideCard(page) {
  await page.evaluate(() => { document.getElementById('gp-card').hidden = true; });
}

async function caption(page, n, text) {
  await page.evaluate(({ n, text }) => {
    const el = document.getElementById('gp-cap');
    el.querySelector('.n').textContent = String(n);
    el.querySelector('.t').textContent = text;
    el.hidden = false;
  }, { n, text });
}

async function moveTo(page, selector) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout: 8000 });
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  const x = box.x + Math.min(box.width / 2, 70);
  const y = box.y + Math.min(box.height / 2, 16);
  await page.evaluate(async ({ x, y }) => {
    const el = document.getElementById('gp-cursor');
    const start = { x: parseFloat(el.style.left) || 640, y: parseFloat(el.style.top) || 360 };
    const dist = Math.hypot(x - start.x, y - start.y);
    const ms = Math.min(620, Math.max(240, dist * 0.55));
    const t0 = performance.now();
    await new Promise(resolve => {
      const step = now => {
        const t = Math.min(1, (now - t0) / ms);
        const e = 1 - Math.pow(1 - t, 3);
        el.style.left = (start.x + (x - start.x) * e) + 'px';
        el.style.top = (start.y + (y - start.y) * e) + 'px';
        if (t < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }, { x, y });
  return loc;
}

async function clickSel(page, selector) {
  const loc = await moveTo(page, selector);
  await page.evaluate(() => {
    const c = document.getElementById('gp-cursor');
    const r = document.getElementById('gp-ripple');
    r.style.left = c.style.left;
    r.style.top = c.style.top;
    r.classList.remove('on');
    void r.offsetWidth;
    r.classList.add('on');
  });
  await loc.click({ force: true });
  await sleep(page, 160);
}

async function goView(page, view) {
  await clickSel(page, '.nav button[data-view="' + view + '"]');
  await page.waitForSelector('#view-' + view + ':not([hidden])');
  await sleep(page, 280);
}

async function encodeMp4(webmPath, mp4Path) {
  const tries = [
    ['24', 'medium'],
    ['28', 'slow'],
    ['32', 'slow']
  ];
  let last = 0;
  for (const [crf, preset] of tries) {
    await run('ffmpeg', [
      '-y', '-i', webmPath,
      '-vf', 'scale=1280:720:flags=lanczos,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', preset, '-crf', crf,
      '-movflags', '+faststart', '-an',
      mp4Path
    ]);
    last = (await stat(mp4Path)).size;
    console.log('mp4', crf, preset, last);
    if (last <= MAX_BYTES) return last;
  }
  throw new Error('walkthrough.mp4 is still ' + last + ' bytes');
}

async function poster(mp4Path, jpgPath) {
  await run('ffmpeg', ['-y', '-ss', '4.2', '-i', mp4Path, '-frames:v', '1', '-q:v', '3', jpgPath]);
}

async function mockApis(page) {
  await page.route('**/api/studio/post', async route => {
    await new Promise(r => setTimeout(r, 900));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POST_BODY) });
  });
  await page.route('**/api/generate', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ draft: DRAFT }) });
  });
  await page.route(/linkedin\.com/, route => route.abort());
  await page.route(/instagram\.com/, route => route.abort());
}

async function story(page) {
  await injectChrome(page);
  await showCard(page, 'Galleypost — fact-checked community posts in minutes', '');
  await sleep(page, 2200);
  await hideCard(page);

  await caption(page, 1, 'Start from the dashboard');
  await sleep(page, 2800);
  await moveTo(page, '#stats');
  await sleep(page, 1200);
  await moveTo(page, '#recentPosts');
  await sleep(page, 1600);

  await caption(page, 2, 'Set your brand voice');
  await goView(page, 'brand');
  await page.waitForFunction(() => {
    const el = document.getElementById('brandName');
    return el && el.value && el.value.length > 2;
  });
  await sleep(page, 1100);
  await moveTo(page, '#brandName');
  await sleep(page, 700);
  await moveTo(page, '#brandFacts');
  await sleep(page, 1400);
  await moveTo(page, '#brandSave');
  await sleep(page, 700);

  await caption(page, 3, 'Paste source facts, then write the week');
  await goView(page, 'studio');
  await page.evaluate(() => { const el = document.getElementById('ideasStatus'); if (el) el.textContent = ''; });
  await clickSel(page, '#addOwn');
  await page.waitForSelector('#own:not([hidden])');
  await clickSel(page, '#ownTitle');
  await page.keyboard.type('London Tech Week community stages', { delay: 22 });
  await clickSel(page, '#ownFacts');
  await page.keyboard.insertText('London Tech Week is adding two community stages this year for first-time attendees.\nWorkshops from Shoreditch.js, Women Who Code London and Rust London.\nCall for sessions closes Friday.');
  await sleep(page, 400);
  await clickSel(page, '#ownSource');
  await page.keyboard.type('London Tech Week, 21 Oct 2026', { delay: 16 });
  await clickSel(page, '#ownSave');
  await page.waitForSelector('#ideas .assign');
  await sleep(page, 350);
  await clickSel(page, '#ideas .assign button');
  await page.waitForFunction(() => {
    const btn = document.getElementById('writeWeek');
    return btn && !btn.disabled;
  });
  await sleep(page, 250);
  await clickSel(page, '#writeWeek');
  await page.waitForSelector('#posts .post, #posts article', { timeout: 12000 });
  await sleep(page, 1400);

  await caption(page, 4, 'Review the checklist and preview');
  const posts = page.locator('#h-posts');
  if (await posts.count()) await posts.scrollIntoViewIfNeeded();
  await sleep(page, 600);
  await moveTo(page, '#studioStepper');
  await sleep(page, 1600);
  await moveTo(page, '#studioPreview');
  await sleep(page, 1800);

  await caption(page, 5, 'Post on LinkedIn — you press Post yourself');
  await clickSel(page, '#previewLi');
  await page.waitForSelector('#dropToast:not([hidden])', { timeout: 4000 }).catch(() => {});
  await sleep(page, 2400);

  await caption(page, 6, 'Open in Instagram, or publish via API');
  await page.evaluate(() => {
    const el = document.getElementById('gp-cap');
    if (el) { el.style.top = '16px'; el.style.bottom = 'auto'; }
  });
  await clickSel(page, '#previewIg');
  await page.waitForSelector('#igDialog:not([hidden])');
  await page.waitForFunction(() => /Open in Instagram|dry-run|API/i.test((document.getElementById('igMode') || {}).textContent || ''));
  await page.evaluate(() => {
    const panel = document.querySelector('.ig-panel');
    if (panel) panel.scrollTop = 0;
    ['igRequestLabel', 'igRequests'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  });
  await sleep(page, 900);
  await moveTo(page, '#igOpen');
  await sleep(page, 800);
  await moveTo(page, '#igPost');
  await sleep(page, 1100);
  await clickSel(page, '#igOpen');
  await sleep(page, 1600);
  await clickSel(page, '#igCancel');
  await page.evaluate(() => {
    const el = document.getElementById('gp-cap');
    if (el) { el.style.top = ''; el.style.bottom = '20px'; }
  });
  await sleep(page, 300);

  await caption(page, 7, 'Drafts live in the Library');
  await goView(page, 'library');
  await page.waitForSelector('#libraryPosts tr');
  await sleep(page, 1000);
  await moveTo(page, '#libraryPosts');
  await sleep(page, 2200);

  await caption(page, 8, 'Open the Guide any time');
  await goView(page, 'guide');
  await sleep(page, 900);
  await moveTo(page, '#guide-h');
  await sleep(page, 1000);
  const shot = page.locator('.guide-shot').first();
  if (await shot.count()) {
    await shot.scrollIntoViewIfNeeded();
    await moveTo(page, '.guide-shot');
  }
  await sleep(page, 2200);

  await showCard(page, 'Built by Zeshaan & Dani with Grok Bot + Cursor', 'Galleypost');
  await sleep(page, 2200);
  await hideCard(page);
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
  const tmp = await mkdtemp(join(tmpdir(), 'gp-walk-'));
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-GB',
    recordVideo: { dir: tmp, size: { width: 1280, height: 720 } },
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await context.addInitScript(({ seed }) => {
    localStorage.setItem('social-engine-theme', 'light');
    localStorage.setItem('social-engine-v2', JSON.stringify(seed));
    document.documentElement.setAttribute('data-theme', 'light');
  }, { seed: SEED });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('download', d => { d.cancel().catch(() => {}); });
  context.on('page', p => { if (p !== page) p.close().catch(() => {}); });
  await mockApis(page);
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
    await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view-dash');
    await page.emulateMedia({ colorScheme: 'light' }).catch(() => {});
    await page.evaluate(() => document.fonts ? document.fonts.ready : null).catch(() => {});
    await sleep(page, 500);
    await story(page);
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    const webm = video ? await video.path() : null;
    if (!webm) throw new Error('Playwright did not write a video');
    const mp4 = join(outDir, 'walkthrough.mp4');
    const jpg = join(outDir, 'walkthrough.jpg');
    await encodeMp4(webm, mp4);
    await poster(mp4, jpg);
    await mkdir('/opt/cursor/artifacts', { recursive: true }).catch(() => {});
    await copyFile(mp4, '/opt/cursor/artifacts/walkthrough.mp4').catch(() => {});
    await copyFile(jpg, '/opt/cursor/artifacts/walkthrough.jpg').catch(() => {});
    await rm(tmp, { recursive: true, force: true });
    const size = (await stat(mp4)).size;
    console.log('Wrote', mp4, size, 'bytes');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
