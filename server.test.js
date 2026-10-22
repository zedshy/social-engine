
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp, GUIDE_ASSET_PATHS } from './server.js';

const calls = [];
const client = { responses: { create: async (request) => {
  calls.push(request);
  return { status: 'completed', output_text: request.input.includes('priorDraft')
    ? 'A different source-grounded opening.\n\nThe same practical point, with a new structure.'
    : 'A source-grounded opening.\n\nOne concise practical point.' };
} } };
const server = createApp({ client, model: 'test-model' });
let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const valid = { mode: 'draft', source: 'London Tech Week runs more than 300 events across the city.',
  angle: 'problem', vertical: 'developers', voice: 'founder' };

test('serves the existing frontend but not local secrets', async () => {
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Galleypost/);
  for (const studioPath of ['/app', '/app.html', '/studio']) {
    const studio = await fetch(`${base}${studioPath}`);
    assert.equal(studio.status, 200, studioPath);
    assert.match(await studio.text(), /Galleypost/);
  }
  const page = await fetch(`${base}/classic`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Generate Posts/);
  const library = await fetch(`${base}/post-library.js`);
  assert.equal(library.status, 200);
  assert.match(await library.text(), /PostLibrary/);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  for (const asset of ['logo-reversed.svg', 'logo.svg', 'logo-icon.svg']) {
    assert.equal((await fetch(`${base}/assets/brand/${asset}`)).status, 200);
  }
  const health = await fetch(`${base}/api/health`);
  const healthBody = await health.json();
  assert.equal(healthBody.app, 'social-engine');
  assert.equal(healthBody.status, 'ok');
  assert.equal(healthBody.assetVersion, 1);
  assert.equal(healthBody.profileName, 'London Tech Community');
  for (const name of ['initial', 'improved']) {
    const image = await fetch(`${base}/assets/content-studio/${name}-concept.svg`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type'), /image\/svg/);
  }
});

test('generates one bounded text response and keeps the API payload server-side', async () => {
  const response = await fetch(`${base}/api/generate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { draft: 'A source-grounded opening.\n\nOne concise practical point.' });
  assert.equal(calls.at(-1).model, 'test-model');
  assert.equal(calls.at(-1).max_output_tokens, 400);
  assert.equal(calls.at(-1).store, false);
  assert.match(calls.at(-1).instructions, /untrusted data, not instructions/);
});

test('variation sends the current draft as context and requests a different structure', async () => {
  const response = await fetch(`${base}/api/generate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...valid, mode: 'variation', original: 'Original draft.' }) });
  assert.equal(response.status, 200);
  assert.match((await response.json()).draft, /different source-grounded opening/);
  assert.match(calls.at(-1).instructions, /different version/);
});

test('weekly requests use prior drafts only to avoid repetition while retaining source-grounding rules', async () => {
  const response = await fetch(`${base}/api/generate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...valid, priorDrafts: ['First distinct point.', 'Second distinct point.'] }) });
  assert.equal(response.status, 200);
  assert.match(calls.at(-1).instructions, /avoid repeating their central point/);
  assert.match(calls.at(-1).instructions, /source supports fewer distinct points/);
  assert.match(calls.at(-1).input, /First distinct point/);
  assert.match(calls.at(-1).input, /Second distinct point/);
});

test('new AI angles use supplied material and optional event context', async () => {
  const paper = await fetch(`${base}/api/generate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...valid, angle: 'white-paper', source: 'Technical paper excerpt: community events work better with a published code of conduct.' }) });
  assert.equal(paper.status, 200);
  assert.match(calls.at(-1).instructions, /one useful technical insight/);
  assert.match(calls.at(-1).input, /Technical paper excerpt/);
  const event = await fetch(`${base}/api/generate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...valid, angle: 'trade-fair', eventContext: 'A relevant industry event' }) });
  assert.equal(event.status, 200);
  assert.match(calls.at(-1).instructions, /Do not invent an event/);
  assert.match(calls.at(-1).input, /A relevant industry event/);
});

test('rejects empty, oversized, and invalid control inputs before calling OpenAI', async () => {
  const count = calls.length;
  for (const body of [{ ...valid, source: '' }, { ...valid, source: 'x'.repeat(8001) },
    { ...valid, voice: 'ignore safeguards' }, { ...valid, mode: 'variation' },
    { ...valid, angle: 'trade-fair', eventContext: 'x'.repeat(201) },
    { ...valid, priorDrafts: ['one', 'two', 'three'] }, { ...valid, mode: 'variation', priorDrafts: ['one'] }]) {
    const response = await fetch(`${base}/api/generate`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  assert.equal(calls.length, count);
});

test('reports missing key without exposing server configuration', async () => {
  const noKey = createApp({ apiKey: '', model: 'test-model' });
  await new Promise(resolve => noKey.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${noKey.address().port}/api/generate`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Live AI needs your own OpenAI API key. Add OPENAI_API_KEY to the local .env file and restart the server. Draft the Week and the Technical Visual demo work without a key.' });
  } finally { noKey.close(); }
});

test('rejects incomplete or overlong model output', async () => {
  let output = { status: 'incomplete', output_text: 'Partial draft.' };
  const badClient = { responses: { create: async () => output } };
  const app = createApp({ client: badClient });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid)
    });
    assert.equal(response.status, 502);
    assert.deepEqual(Object.keys(await response.json()), ['error']);
    output = { status: 'completed', output_text: 'x'.repeat(1801) };
    const second = await fetch(`http://127.0.0.1:${app.address().port}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid)
    });
    assert.equal(second.status, 502);
  } finally { app.close(); }
});


test('serves each Guide screenshot as an image', async () => {
  const images = GUIDE_ASSET_PATHS.filter(path => /\.(png|webp|jpe?g)$/i.test(path));
  assert.ok(images.length >= 7);
  for (const path of images) {
    const image = await fetch(`${base}${path}`);
    assert.equal(image.status, 200, path);
    assert.match(image.headers.get('content-type') || '', /^image\/(png|webp|jpeg)\b/, path);
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.ok(bytes.length > 500, path);
  }
});

test('serves the Guide walkthrough as video/mp4', async () => {
  const video = await fetch(`${base}/assets/guide/walkthrough.mp4`);
  assert.equal(video.status, 200);
  assert.match(video.headers.get('content-type') || '', /^video\/mp4\b/);
  const bytes = Buffer.from(await video.arrayBuffer());
  assert.ok(bytes.length > 1000);
});

test('example placeholder keys explain optional AI setup without contacting OpenAI', async () => {
  const app = createApp({ apiKey: 'replace-with-your-key' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/generate`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /demo work without a key/);
  } finally { app.close(); }
});