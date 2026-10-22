
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createApp } from './server.js';
import { editPrompt, imagePrompt, scenes } from './studio.js';

const PNG = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64');
const textCalls = [];
const imageCalls = [];
const client = {
  responses: { create: async (request) => {
    textCalls.push(request);
    if (request.text.format.name === 'photo_catalogue') return { status: 'completed', output_text: JSON.stringify({ name: 'Laptops in a co-working space', notes: 'People collaborating around laptops in a bright room.', tags: ['Meetup', 'laptops', 'community'], people: false }) };
    if (request.text.format.name === 'shot_brief') {
      if (request.tools && globalThis.__noSearch) throw Object.assign(new Error('tool unsupported'), { status: 400 });
      return { status: 'completed', output: request.tools ? [{ type: 'web_search_call' }] : [], output_text: JSON.stringify({
        summary: 'A meetup in a co-working space.', mustShow: ['Laptops on shared tables', 'Warm room lighting'],
        mustNotShow: ['Corporate boardroom', 'Any text'], openQuestions: ['Is a projector normally used?'],
        references: [{ title: 'Manual', url: 'https://example.com/manual' }, { title: 'bad', url: 'javascript:alert(1)' }] }) };
    }
    return { status: 'completed', output_text: JSON.stringify({
      headline: 'Meetup done right', post: 'A community meetup runs on shared tables.\n\nKeep the brief published.',
      hashtags: ['community'], factsUsed: ['Shared tables'], toCheck: ['Brief wording'] }) };
  } },
  images: {
    generate: async (request) => { imageCalls.push({ kind: 'generate', request }); return { data: [{ b64_json: PNG }] }; },
    edit: async (request) => { imageCalls.push({ kind: 'edit', request }); return { data: [{ b64_json: PNG }] }; }
  }
};
const server = createApp({ client, model: 'test-model' });
let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const facts = 'community meetups run on shared tables in a co-working space. A published brief helps first-time attendees.';

test('serves the studio page and its options', async () => {
  const page = await fetch(`${base}/studio`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Galleypost/);
  const options = await (await fetch(`${base}/api/studio/options`)).json();
  assert.equal(options.liveAvailable, true);
  assert.ok(options.subjects.some(s => s.id === 'general'));
  assert.ok(options.scenes.some(s => s.id === 'workspace'));
});

test('studio page includes the Guide nav', async () => {
  const page = await fetch(`${base}/app.html`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-view="guide"/);
  assert.match(html, /<span>Guide<\/span>/);
  assert.match(html, /id="helpLink"/);
  assert.match(html, /id="view-guide"/);
  assert.match(html, /class="guide-shot"/);
  assert.match(html, /\/assets\/guide\/dashboard\.webp/);
  assert.match(html, /\/assets\/guide\/instagram\.webp/);
  assert.match(html, /<video[^>]*controls/);
  assert.match(html, /\/assets\/guide\/walkthrough\.mp4/);
  assert.match(html, /poster="\/assets\/guide\/walkthrough\.jpg"/);
});

test('article is grounded in supplied facts and returns what to check', async () => {
  const res = await post('/api/studio/article', { subject: 'industry-news', facts });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.headline, 'Meetup done right');
  assert.deepEqual(body.toCheck, ['Brief wording']);
  const request = textCalls.at(-1);
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, 'json_schema');
  assert.match(request.instructions, /only permitted source of factual claims/);
  assert.match(request.input, /shared tables/);
});

test('article refuses to write without facts or with an unknown subject', async () => {
  const before = textCalls.length;
  assert.equal((await post('/api/studio/article', { subject: 'industry-news', facts: 'too short' })).status, 400);
  assert.equal((await post('/api/studio/article', { subject: 'nonsense', facts })).status, 400);
  assert.equal(textCalls.length, before);
});

test('image prompt carries the checklist, forbids text, and puts the correction last', () => {
  const prompt = imagePrompt({ scene: scenes.workspace, extra: '', correction: 'Remove the big screen', hasReference: false });
  assert.match(prompt, /Clean, well-lit professional environment/);
  assert.match(prompt, /must not show/);
  assert.match(prompt, /Do not draw any written text/);
  assert.ok(prompt.trim().endsWith('Correction from the reviewer, which takes priority over everything above: Remove the big screen'));
});

test('image generation returns a PNG data URL and sends a portrait request', async () => {
  const res = await post('/api/studio/image', { scene: 'workspace', correction: 'The lighting is too harsh' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.image, /^data:image\/jpeg;base64,/);
  const { kind, request } = imageCalls.at(-1);
  assert.equal(kind, 'generate');
  assert.equal(request.size, '1024x1536');
  assert.match(request.prompt, /The lighting is too harsh/);
});

test('a reference photo switches to image edit; bad references and empty custom scenes are refused', async () => {
  const ok = await post('/api/studio/image', { scene: 'workspace', reference: `data:image/png;base64,${PNG}` });
  assert.equal(ok.status, 200);
  assert.equal(imageCalls.at(-1).kind, 'edit');
  assert.match(imageCalls.at(-1).request.prompt, /Match its design/);
  const count = imageCalls.length;
  assert.equal((await post('/api/studio/image', { scene: 'workspace', reference: 'data:text/html;base64,AAAA' })).status, 400);
  assert.equal((await post('/api/studio/image', { scene: 'custom' })).status, 400);
  assert.equal((await post('/api/studio/image', { scene: 'nonsense' })).status, 400);
  assert.equal(imageCalls.length, count);
});

test('rejects cross-origin requests and non-JSON without calling OpenAI', async () => {
  const count = imageCalls.length;
  const cross = await fetch(`${base}/api/studio/image`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ scene: 'workspace' }) });
  assert.equal(cross.status, 403);
  const plain = await fetch(`${base}/api/studio/image`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(plain.status, 415);
  assert.equal(imageCalls.length, count);
});

test('without a key the studio says so instead of failing silently', async () => {
  const bare = createApp({ apiKey: '' });
  await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${bare.address().port}`;
    assert.equal((await (await fetch(`${url}/api/studio/options`)).json()).liveAvailable, false);
    const res = await fetch(`${url}/api/studio/article`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: 'industry-news', facts }) });
    assert.equal(res.status, 503);
  } finally { bare.close(); }
});

test('plan researches first, drops unsafe links, and keeps open questions for the reviewer', async () => {
  const cheap = await post('/api/studio/plan', { scene: 'workspace' });
  assert.equal(cheap.status, 200);
  assert.equal((await cheap.json()).researched, false, 'no web search unless asked');
  assert.equal(textCalls.at(-1).tools, undefined);
  const res = await post('/api/studio/plan', { scene: 'workspace', research: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.researched, true);
  assert.deepEqual(body.references, [{ title: 'Manual', url: 'https://example.com/manual' }]);
  assert.deepEqual(body.openQuestions, ['Is a projector normally used?']);
  const request = textCalls.at(-1);
  assert.deepEqual(request.tools, [{ type: 'web_search' }]);
  assert.match(request.instructions, /research how this situation is really done/);
  assert.equal(request.store, false);
});

test('a correction sends the current checklist back to the planner as authoritative input', async () => {
  const plan = { mustShow: ['Laptops on shared tables'], mustNotShow: ['Big screen'] };
  await post('/api/studio/plan', { scene: 'workspace', plan, correction: 'This looks unrealistic' });
  const input = JSON.parse(textCalls.at(-1).input);
  assert.deepEqual(input.startingChecklist, plan);
  assert.equal(input.reviewerCorrection, 'This looks unrealistic');
});

test('plan falls back to no web search, and says so', async () => {
  globalThis.__noSearch = true;
  try {
    const body = await (await post('/api/studio/plan', { scene: 'workspace' })).json();
    assert.equal(body.researched, false);
  } finally { delete globalThis.__noSearch; }
});

test('the approved plan, not the built-in list, drives the image prompt; invalid plans are refused', async () => {
  const ok = await post('/api/studio/image', { scene: 'workspace', plan: { mustShow: ['A red laptop sticker'], mustNotShow: ['Rain'] } });
  assert.equal(ok.status, 200);
  const prompt = imageCalls.at(-1).request.prompt;
  assert.match(prompt, /A red laptop sticker/);
  assert.doesNotMatch(prompt, /Clean, well-lit professional environment/);
  const count = imageCalls.length;
  assert.equal((await post('/api/studio/image', { scene: 'workspace', plan: { mustShow: ['x'.repeat(300)], mustNotShow: ['y'] } })).status, 400);
  assert.equal((await post('/api/studio/plan', { scene: 'custom' })).status, 400);
  assert.equal(imageCalls.length, count);
});

test('a hosted copy is locked without a password, and a password gate works', async () => {
  const mk = access => createApp({ client, model: 'test-model', access });
  const call = async (app, path, headers = {}) => {
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    try { return await fetch(`http://127.0.0.1:${app.address().port}${path}`, { headers }); } finally { app.close(); }
  };
  const basic = pw => ({ Authorization: 'Basic ' + Buffer.from('anyone:' + pw).toString('base64') });
  assert.equal((await call(mk({ password: '', hosted: false }), '/api/health')).status, 200, 'local use needs no password');
  const locked = await call(mk({ password: '', hosted: true }), '/api/studio/options');
  assert.equal(locked.status, 503);
  assert.match(await locked.text(), /APP_PASSWORD/);
  const noAuth = await call(mk({ password: 'letmein', hosted: true }), '/');
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate'), /Basic/);
  assert.equal((await call(mk({ password: 'letmein', hosted: true }), '/', basic('wrong'))).status, 401);
  assert.equal((await call(mk({ password: 'letmein', hosted: true }), '/', basic('letmein'))).status, 200);
});

test('the same-site check accepts https behind a host and still rejects other sites', async () => {
  const post = (headers) => fetch(`${base}/api/studio/article`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({}) });
  const host = new URL(base).host;
  assert.equal((await post({ Origin: `https://${host}` })).status, 400, 'same host over https gets past the origin check');
  assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
});

test('the story reaches the image brief and prompt, and place cues and accurate flags are required', async () => {
  const story = { title: 'UK tech hiring fell 2.1% as London Tech Week adds stages', facts: ['The ONS recorded a 2.1% decrease in UK tech hiring.', 'Organisers will add two community stages at London Tech Week.', 'x'.repeat(500), 'fourth fact is dropped'] };
  const res = await post('/api/studio/plan', { scene: 'custom', extra: 'A community venue', story });
  assert.equal(res.status, 200);
  const request = textCalls.at(-1);
  const input = JSON.parse(request.input);
  assert.match(input.story, /London Tech Week/);
  assert.ok(input.story.length <= 700);
  assert.doesNotMatch(input.story, /fourth fact/);
  assert.match(request.instructions, /place unmistakable/);
  assert.match(request.instructions, /Flags and national symbols are fine/);
  const img = await post('/api/studio/image', { scene: 'custom', extra: 'A community venue', story, plan: { mustShow: ['The Union Flag flying'], mustNotShow: ['Written text'] } });
  assert.equal(img.status, 200);
  const prompt = imageCalls.at(-1).request.prompt;
  assert.match(prompt, /Story this image illustrates: UK tech hiring fell 2\.1%/);
  assert.match(prompt, /accurate national flag/);
  assert.match(prompt, /National flags and symbols are allowed and welcome/);
  assert.doesNotMatch(prompt, /logos or watermarks anywhere in the image\.$/);
  const none = await post('/api/studio/image', { scene: 'custom', extra: 'A venue at dusk' });
  assert.doesNotMatch(imageCalls.at(-1).request.prompt, /Story this image illustrates/);
});

test('photo edit mode needs a photo and an instruction, uses the edit endpoint, and tells the model to preserve the photograph', async () => {
  const photo = `data:image/jpeg;base64,${PNG}`;
  assert.equal((await post('/api/studio/image', { mode: 'edit', scene: 'custom', extra: 'make the sky clearer' })).status, 400, 'no photo');
  assert.equal((await post('/api/studio/image', { mode: 'edit', scene: 'custom', reference: photo })).status, 400, 'no instruction');
  const count = imageCalls.length;
  const ok = await post('/api/studio/image', { mode: 'edit', scene: 'custom', extra: 'make the sky clearer', reference: photo, story: { title: 'Rail certification' } });
  assert.equal(ok.status, 200);
  assert.equal(imageCalls.length, count + 1);
  const { kind, request } = imageCalls.at(-1);
  assert.equal(kind, 'edit');
  assert.match(request.prompt, /real photograph from London Tech Community/);
  assert.match(request.prompt, /must stay exactly as photographed/);
  assert.match(request.prompt, /Apply only this change: make the sky clearer/);
  assert.match(request.prompt, /Rail certification/);
  assert.doesNotMatch(request.prompt, /Create a photorealistic/);
  assert.match(editPrompt({ instruction: 'x' }), /smallest possible change/);
});

test('every element the page script looks up by id exists in the page, and the script parses', () => {
  const html = readFileSync(new URL('./app.html', import.meta.url), 'utf8');
  const ids = [...new Set([...html.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))];
  const missing = ids.filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `ids used by the script but missing from the page: ${missing.join(', ')}`);
  const script = html.match(/<script>\s*\(function \(\) \{\s*'use strict';[\s\S]*<\/script>/)[0].replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.doesNotThrow(() => new Function(script));
});

test('images are drafts by default, final quality on request, and use is counted', async () => {
  await post('/api/studio/image', { scene: 'workspace' });
  assert.equal(imageCalls.at(-1).request.quality, 'low');
  await post('/api/studio/image', { scene: 'workspace', quality: 'medium' });
  assert.equal(imageCalls.at(-1).request.quality, 'medium');
  await post('/api/studio/image', { scene: 'workspace', quality: 'bogus' });
  assert.equal(imageCalls.at(-1).request.quality, 'low');
  const usage = await (await fetch(`${base}/api/studio/usage`)).json();
  assert.ok(Object.values(usage.images).reduce((a, b) => a + b, 0) >= 3);
  assert.ok(usage.searches >= 1);
});

test('each image gets its own camera and light, and avoids what the week already shows', async () => {
  const { imagePrompt, pickStyle } = await import('./studio.js');
  const a = pickStyle(() => 0), b = pickStyle(() => 0.99);
  assert.notDeepEqual(a, b);
  const prompt = imagePrompt({ scene: scenes.custom, extra: 'x', style: a, avoid: ['Laptops at dusk in a co-working space'] });
  assert.match(prompt, /Camera and light for this shot/);
  assert.match(prompt, /clearly different[\s\S]*Laptops at dusk in a co-working space/);
  assert.doesNotMatch(imagePrompt({ scene: scenes.custom, extra: 'x', style: a, hasReference: true }), /Camera and light/);
  await post('/api/studio/image', { scene: 'custom', extra: 'a venue', avoid: ['Laptops at dusk in a co-working space'] });
  assert.match(imageCalls.at(-1).request.prompt, /Camera and light/);
  assert.match(imageCalls.at(-1).request.prompt, /Laptops at dusk in a co-working space/);
});

test('around mode needs a photo, keeps the subject, and builds the scene in the post format', async () => {
  const photo = `data:image/png;base64,${PNG}`;
  const count = imageCalls.length;
  assert.equal((await post('/api/studio/image', { mode: 'around', scene: 'custom', extra: 'a co-working space' })).status, 400, 'no photo');
  assert.equal(imageCalls.length, count);
  const ok = await post('/api/studio/image', { mode: 'around', scene: 'custom', extra: 'a co-working space at dusk', reference: photo, aspect: 'portrait', avoid: ['Laptops at dusk'] });
  assert.equal(ok.status, 200);
  const { kind, request } = imageCalls.at(-1);
  assert.equal(kind, 'edit');
  assert.equal(request.size, '1024x1536');
  assert.match(request.prompt, /Keep the subject exactly as photographed/);
  assert.match(request.prompt, /a co-working space at dusk/);
  assert.match(request.prompt, /Laptops at dusk/);
  const noText = await post('/api/studio/image', { mode: 'around', scene: 'custom', reference: photo });
  assert.equal(noText.status, 200, 'the scene description is optional');
});

test('describing a photo returns a name, notes and tags, and refuses anything that is not a photo', async () => {
  const photo = `data:image/png;base64,${PNG}`;
  const ok = await post('/api/studio/describe', { image: photo });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.name, 'Laptops in a co-working space');
  assert.deepEqual(body.tags, ['meetup', 'laptops', 'community']);
  assert.equal(body.people, false);
  const request = textCalls.at(-1);
  assert.equal(request.input[0].content[1].image_url, photo);
  assert.equal(request.input[0].content[1].detail, 'low');
  assert.match(request.instructions, /Do not name or guess who any person is/);
  assert.equal((await post('/api/studio/describe', { image: 'data:text/html;base64,AAAA' })).status, 400);
  assert.equal((await post('/api/studio/describe', {})).status, 400);
});