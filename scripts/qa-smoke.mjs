#!/usr/bin/env node
/**
 * Pre-ship UI smoke. Playwright is capture-only — not a runtime dependency:
 *   npm i --no-save --no-package-lock playwright
 *   node scripts/qa-smoke.mjs
 *
 * Loads /, /app.html, /classic and every Studio view at 1024×768, 1280×800,
 * 1440×900 and 390×844. Fails on console errors, own-origin 4xx/5xx, horizontal
 * overflow, wrapping buttons/pills, clipped panels, broken media.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Capture-only (do not add it to package.json):\n  npm i --no-save --no-package-lock playwright\n  node scripts/qa-smoke.mjs');
  process.exit(1);
}

const VIEWPORTS = [
  { name: '1024x768', width: 1024, height: 768 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '390x844', width: 390, height: 844 }
];
const STUDIO_VIEWS = [
  ['dash', 'Dashboard'],
  ['studio', 'Studio'],
  ['library', 'Library'],
  ['brand', 'Brand'],
  ['settings', 'Settings'],
  ['assistant', 'Assistant'],
  ['analytics', 'Analytics'],
  ['guide', 'Guide']
];

const DRAFT = 'London Tech Week is adding two community stages this year, aimed at first-time attendees and local meetups rather than the main expo floor.\n\nOrganisers say the stages will run workshops from Shoreditch.js, Women Who Code London and Rust London — not keynotes. If you run a meetup, the call for sessions closes Friday.';

const TOPIC = {
  id: 'qa-mon',
  title: 'London Tech Week adds two community stages',
  category: 'events',
  categoryLabel: 'Events',
  date: '2026-10-21',
  facts: [
    { text: 'London Tech Week is adding two community stages this year.', source: 'London Tech Week', date: '2026-10-21', url: 'https://londontechweek.example/stages' }
  ],
  bestDay: 'mon',
  trusted: true,
  confirmed: true
};

const SEED = {
  topics: [TOPIC],
  researchedAt: '2026-10-21T10:00:00.000Z',
  week: { mon: TOPIC, wed: null, fri: null },
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function chromePath() {
  return process.env.CHROME
    || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/local/bin/google-chrome');
}

function ownUrl(url, origin) {
  try { return new URL(url).origin === origin; }
  catch { return false; }
}

function ignoreFailedUrl(url) {
  return /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|linkedin\.com|instagram\.com/i.test(url);
}

function postJson(route) {
  try { return route.request().postDataJSON() || {}; }
  catch { return {}; }
}

async function mockApis(page) {
  await page.route('**/api/studio/post', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POST_BODY) });
  });
  await page.route('**/api/generate', async route => {
    const draft = postJson(route).mode === 'variation'
      ? 'A different source-grounded opening.\n\nThe same practical point, with a new structure.'
      : DRAFT;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ draft }) });
  });
  await page.route('**/api/instagram/publish', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dryRun: true, published: false, caption: DRAFT, warnings: [], canPublish: true,
        requests: [{ method: 'POST', url: 'https://graph.instagram.com/v26.0/{ig-user-id}/media' }]
      })
    });
  });
  await page.route('**/api/profiles/load', async route => {
    const id = postJson(route).id || 'default';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, profile: { id, name: 'London Tech Community', tagline: 'Connecting London\'s tech builders', website: '', profileFacts: [] } })
    });
  });
  await page.route('**/api/profile', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = postJson(route);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, profile: body }) });
  });
  await page.route(/linkedin\.com/, route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
  await page.route(/instagram\.com/, route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
}

function attachGuards(page, origin, bucket) {
  page.on('pageerror', error => {
    const stack = error && error.stack ? String(error.stack) : '';
    bucket.pageErrors.push(String(error && error.message ? error.message : error) + (stack ? ' | ' + stack.split('\n').slice(0, 4).join(' ') : ''));
  });
  page.on('console', msg => {
    if (msg.type() === 'error') bucket.consoleErrors.push(msg.text());
  });
  page.on('response', response => {
    const url = response.url();
    const status = response.status();
    if (status < 400 || ignoreFailedUrl(url) || !ownUrl(url, origin)) return;
    bucket.failed.push(status + ' ' + url);
  });
  page.on('requestfailed', request => {
    const url = request.url();
    if (ignoreFailedUrl(url) || !ownUrl(url, origin)) return;
    const err = request.failure();
    if (err && /net::ERR_ABORTED|NS_BINDING_ABORTED/.test(err.errorText || '')) return;
    bucket.failed.push((err && err.errorText) + ' ' + url);
  });
}

async function inspect(page, label) {
  return page.evaluate(where => {
    const problems = [];
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      problems.push(where + ': horizontal overflow ' + document.documentElement.scrollWidth + '>' + window.innerWidth);
    }
    const targets = document.querySelectorAll('button.btn, button.pill, .pill, button.tab, .nav button');
    for (const el of targets) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]') || (el.offsetParent === null && el.offsetWidth === 0)) continue;
      const nowrap = /\bnowrap\b/.test(cs.whiteSpace);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      if (!nowrap && el.scrollHeight > lh * 2.2) {
        problems.push(where + ': wrapping control "' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) + '"');
      }
    }
    const panels = document.querySelectorAll('.glass, .pane, .studio-rail, .ig-panel, .page-h, .hero, .stats, .li-card, .cmdk .box');
    for (const el of panels) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || el.offsetParent === null && el.offsetWidth === 0) continue;
      if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX === 'hidden') {
        problems.push(where + ': clipped panel ' + (el.id || el.className));
      }
    }
    for (const img of document.images) {
      if (!img.src || img.closest('[hidden]')) continue;
      if (img.complete && img.naturalWidth === 0) problems.push(where + ': broken image ' + img.src);
    }
    for (const video of document.querySelectorAll('video')) {
      if (video.error) problems.push(where + ': broken video');
    }
    return problems;
  }, label);
}

async function gotoStudio(page, view) {
  await page.evaluate(v => {
    const btn = document.querySelector('.nav button[data-view="' + v + '"]');
    if (btn) btn.click();
  }, view);
  await page.waitForSelector('#view-' + view + ':not([hidden])');
}

async function seed(page) {
  await page.addInitScript(({ seed }) => {
    try {
      localStorage.setItem('social-engine-theme', 'light');
      localStorage.setItem('social-engine-v2', JSON.stringify(seed));
      if (document.documentElement) document.documentElement.setAttribute('data-theme', 'light');
    } catch (e) {}
  }, { seed: SEED });
}

async function open(browser, base, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'light',
    locale: 'en-GB',
    permissions: ['clipboard-read', 'clipboard-write']
  });
  await seed(context);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await mockApis(page);
  const bucket = { pageErrors: [], consoleErrors: [], failed: [] };
  attachGuards(page, new URL(base).origin, bucket);
  return { context, page, bucket };
}

function failIf(bucket, extra, label) {
  const all = [
    ...bucket.pageErrors.map(x => 'uncaught: ' + x),
    ...bucket.consoleErrors.map(x => 'console: ' + x),
    ...bucket.failed.map(x => 'network: ' + x),
    ...extra
  ];
  if (!all.length) return;
  throw new Error(label + '\n  - ' + all.join('\n  - '));
}

async function loadMatrix(browser, base) {
  for (const vp of VIEWPORTS) {
    const { context, page, bucket } = await open(browser, base, vp);
    try {
      for (const path of ['/', '/app.html', '/classic']) {
        await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(250);
        const extra = await inspect(page, vp.name + ' ' + path);
        failIf(bucket, extra, vp.name + ' ' + path);
        bucket.pageErrors.length = 0;
        bucket.consoleErrors.length = 0;
        bucket.failed.length = 0;
      }
      await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#view-dash');
      for (const [id, name] of STUDIO_VIEWS) {
        await gotoStudio(page, id);
        await page.waitForTimeout(200);
        const extra = await inspect(page, vp.name + ' ' + name);
        failIf(bucket, extra, vp.name + ' view ' + name);
        bucket.pageErrors.length = 0;
        bucket.consoleErrors.length = 0;
        bucket.failed.length = 0;
      }
      console.log('ok views', vp.name);
    } finally { await context.close(); }
  }
}

async function exercise(browser, base) {
  const vp = { name: '1280x800', width: 1280, height: 800 };
  const { context, page, bucket } = await open(browser, base, vp);
  const extra = [];
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
    await page.goto(base + '/app.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#view-dash');

    await gotoStudio(page, 'studio');
    await page.waitForFunction(() => {
      const btn = document.getElementById('writeWeek');
      return btn && !btn.disabled;
    });
    await page.click('#writeWeek');
    await page.waitForFunction(() => {
      const el = document.getElementById('stepWrite');
      return el && /drafted|Writing/i.test(el.textContent || '');
    });
    await page.waitForSelector('#posts article, #posts .post, #previewBody');
    const checklist = await page.locator('#studioStepper').textContent();
    if (!/Write|Fact-check|Lint/i.test(checklist || '')) extra.push('checklist missing');
    await page.click('button:has-text("Write it again")');
    await page.waitForTimeout(400);

    let linkedin = false;
    page.on('popup', p => { linkedin = true; p.close().catch(() => {}); });
    await page.click('#previewLi');
    await page.waitForTimeout(400);
    if (!linkedin) {
      const opened = await page.evaluate(() => document.getElementById('dropToast') && !document.getElementById('dropToast').hidden);
      if (!opened) extra.push('LinkedIn handoff did not toast or popup');
    }

    await page.click('#previewIg');
    await page.waitForSelector('#igDialog:not([hidden])');
    extra.push(...await inspect(page, 'instagram dialog'));
    await page.click('#igOpen');
    await page.waitForTimeout(300);
    await page.click('#igPost');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#igDialog[hidden]', { state: 'attached' });

    await gotoStudio(page, 'library');
    const dir = await mkdtemp(join(tmpdir(), 'gp-qa-'));
    const photo = join(dir, 'qa.png');
    await writeFile(photo, PNG);
    await page.setInputFiles('#libFile', photo);
    await page.waitForFunction(() => document.querySelector('#libGrid button') || /added/i.test((document.getElementById('libStatus') || {}).textContent || ''));
    page.once('dialog', d => d.accept());
    const del = page.locator('#libGrid button:has-text("Delete")');
    if (await del.count()) await del.first().click();
    await page.waitForTimeout(300);

    await gotoStudio(page, 'brand');
    await page.waitForFunction(() => {
      const el = document.getElementById('brandSwitch');
      return el && el.options && el.options.length > 0;
    });
    const ids = await page.locator('#brandSwitch option').evaluateAll(opts => opts.map(o => o.value));
    const current = await page.locator('#brandSwitch').inputValue();
    const next = ids.find(id => id && id !== current) || ids[0];
    if (next) await page.selectOption('#brandSwitch', next);
    await page.waitForTimeout(400);
    await page.fill('#brandTagline', 'Connecting London\'s tech builders');
    await page.click('#brandSave');
    await page.waitForFunction(() => /saved/i.test((document.getElementById('brandStatus') || {}).textContent || ''));

    await gotoStudio(page, 'settings');
    await page.click('#theme');
    const dark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (dark !== 'dark') extra.push('theme did not switch to dark');
    extra.push(...await inspect(page, 'dark settings'));
    await page.click('#theme');
    const light = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (light !== 'light') extra.push('theme did not switch back to light');

    await page.keyboard.press('Meta+k');
    await page.waitForSelector('#cmdk:not([hidden])');
    extra.push(...await inspect(page, 'command palette'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#cmdk[hidden]', { state: 'attached' });

    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await page.waitForSelector('#view-studio:not([hidden])');
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await page.waitForSelector('#view-guide:not([hidden])');

    await page.locator('.guide-shot-open').first().click();
    await page.waitForSelector('#guideLb:not([hidden])');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => {
      const el = document.getElementById('guideLb');
      return el && el.hidden;
    });

    const played = await page.evaluate(async () => {
      const video = document.querySelector('#view-guide video');
      if (!video) return 'missing';
      video.muted = true;
      try { await video.play(); } catch (e) { return String(e.message || e); }
      const ok = !video.paused && video.readyState >= 2;
      video.pause();
      return ok ? 'ok' : 'readyState ' + video.readyState;
    });
    if (played !== 'ok') extra.push('guide video did not play (' + played + ')');

    await page.goto(base + '/classic', { waitUntil: 'domcontentloaded' });
    await page.click('#tab-engine');
    await page.click('#weeklyPostsTab');
    const createWeek = page.locator('#createWeek');
    if (await createWeek.isVisible()) await createWeek.click();
    await page.locator('#generateAi').waitFor({ state: 'visible' });
    extra.push(...await inspect(page, 'classic generate'));
    await page.click('#generateAi');
    await page.waitForFunction(() => /ready|saved|draft|variation/i.test((document.getElementById('aiStatus') || {}).textContent || ''), { timeout: 15000 });
    const variation = page.locator('.ai-variation-button, button:has-text("Generate AI variation")');
    if (await variation.count()) {
      await variation.first().click();
      await page.waitForTimeout(500);
    }

    extra.push(...await inspect(page, 'classic after generate'));
    failIf(bucket, extra, 'exercise');
    console.log('ok exercise');
  } finally { await context.close(); }
}

async function main() {
  const server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    await loadMatrix(browser, base);
    await exercise(browser, base);
    console.log('qa-smoke passed');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
