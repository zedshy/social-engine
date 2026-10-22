
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { createApp } from './server.js';
import vercelHandler from './api/index.js';

const calls = [];
const client = { responses: { create: async (request) => {
  calls.push(request);
  return { status: 'completed', output_text: 'A source-grounded opening.\n\nOne concise practical point.' };
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

test('health identifies the app as galleypost', async () => {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json().then(({ app, status }) => ({ app, status })), { app: 'galleypost', status: 'ok' });
});

test('unknown routes are 404, not 500, and unknown methods are not 500', async () => {
  assert.equal((await fetch(`${base}/no-such-page`)).status, 404);
  assert.equal((await fetch(`${base}/api/no-such-route`)).status, 404);
  const post = await fetch(`${base}/api/no-such-route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(post.status === 404 || post.status === 405);
  assert.notEqual(post.status, 500);
});

test('generate rejects bad JSON, the wrong content-type, and oversize bodies', async () => {
  const bad = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON/i);

  const type = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(valid) });
  assert.equal(type.status, 415);

  const huge = await fetch(`${base}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...valid, source: 'x'.repeat(13000) })
  });
  assert.equal(huge.status, 413);
});

test('generate without a key returns the friendly 503', async () => {
  const noKey = createApp({ apiKey: '', model: 'test-model' });
  await new Promise(resolve => noKey.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${noKey.address().port}/api/generate`, { method: 'POST' });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /demo work without a key/);
  } finally { noKey.close(); }
});

test('Instagram preview returns validation errors instead of 500', async () => {
  const missing = await fetch(`${base}/api/instagram/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /caption/i);

  const array = await fetch(`${base}/api/instagram/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]'
  });
  assert.equal(array.status, 400);

  const long = await fetch(`${base}/api/instagram/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caption: 'x'.repeat(20001) })
  });
  assert.equal(long.status, 400);

  const type = await fetch(`${base}/api/instagram/preview`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}'
  });
  assert.equal(type.status, 415);
});

test('static assets refuse path traversal and missing files 404', async () => {
  assert.equal((await fetch(`${base}/assets/../.env`)).status, 404);
  assert.equal((await fetch(`${base}/assets/guide/%2e%2e/%2e%2e/.env`)).status, 404);
  assert.equal((await fetch(`${base}/assets/guide/nope-not-a-file.webp`)).status, 404);
  const env = await fetch(`${base}/.env`);
  assert.equal(env.status, 404);
  const body = await env.text();
  assert.doesNotMatch(body, /OPENAI_API_KEY\s*=\s*sk-/);
});

test('profile load refuses traversal and unknown ids without 500', async () => {
  const traversal = await fetch(`${base}/api/profiles/load`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '../../../.env' })
  });
  assert.equal(traversal.status, 400);
  assert.notEqual(traversal.status, 500);

  const missing = await fetch(`${base}/api/profiles/load`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'not-a-real-profile' })
  });
  assert.equal(missing.status, 404);

  const type = await fetch(`${base}/api/profiles/load`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"id":"default"}'
  });
  assert.equal(type.status, 415);
});

test('Vercel handler serves the same routes including Guide assets', async () => {
  assert.equal(typeof vercelHandler, 'function');
  const hosted = createServer(vercelHandler);
  await new Promise(resolve => hosted.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${hosted.address().port}`;
  try {
    assert.equal((await fetch(root)).status, 200);
    assert.equal((await fetch(`${root}/classic`)).status, 200);
    assert.equal((await fetch(`${root}/api/health`)).status, 200);
    const shot = await fetch(`${root}/assets/guide/dashboard.webp`);
    assert.equal(shot.status, 200);
    assert.match(shot.headers.get('content-type') || '', /^image\/webp\b/);
    const video = await fetch(`${root}/assets/guide/walkthrough.mp4`);
    assert.equal(video.status, 200);
    assert.match(video.headers.get('content-type') || '', /^video\/mp4\b/);
    assert.equal((await fetch(`${root}/assets/../.env`)).status, 404);
  } finally { hosted.close(); }
});
