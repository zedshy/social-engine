import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './server.js';
import { prepareCaption, createInstagramPublisher, CAPTION_LIMIT, HASHTAG_LIMIT } from './instagram-publisher.js';

const TOKEN = 'IGAATOKEN123456789';
const USER = '17841400000000000';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_URL = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('caption preview trims Instagram length and hashtag limits', () => {
  const tags = Array.from({ length: HASHTAG_LIMIT + 1 }, (_, index) => `#tag${index}`).join(' ');
  const hashed = prepareCaption(`Hello\n\n${tags}`);
  assert.equal(hashed.hashtagCount, HASHTAG_LIMIT);
  assert.equal(hashed.caption.includes('#tag30'), false);
  assert.match(hashed.warnings.join(' '), /Removed 1 extra hashtag/);

  const long = prepareCaption('a'.repeat(CAPTION_LIMIT + 1));
  assert.equal(long.length, CAPTION_LIMIT);
  assert.equal(long.caption.length, CAPTION_LIMIT);
  assert.match(long.warnings.join(' '), /shortened by 1/);
});

test('dry-run describes the Graph calls and never contacts Instagram', async () => {
  const publisher = createInstagramPublisher({
    accessToken: '', userId: '', graphVersion: 'v26.0', publicBaseUrl: '',
    fetchImpl: () => { throw new Error('fetch should not be called'); }
  });
  const preview = publisher.preview({ caption: 'A community meetup.', hasImage: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.published, false);
  assert.match(preview.body.imageProblem, /PUBLIC_BASE_URL/);
  assert.equal(preview.body.requests[0].method, 'POST');
  assert.equal(preview.body.requests[0].url, 'https://graph.instagram.com/v26.0/{ig-user-id}/media');
  assert.deepEqual(preview.body.requests[0].body, { image_url: null, caption: 'A community meetup.' });
  assert.equal(preview.body.requests[1].url, 'https://graph.instagram.com/v26.0/{ig-user-id}/media_publish');
  assert.equal(preview.body.requests[1].body.creation_id, '<container id from the media response>');
  const published = await publisher.publish({ caption: 'A community meetup.', hasImage: true });
  assert.equal(published.status, 200);
  assert.equal(published.body.dryRun, true);
  assert.equal(JSON.stringify(published.body).includes(TOKEN), false);
});

test('live publish creates a container, waits until it is ready, then publishes', async () => {
  const calls = [];
  const publisher = createInstagramPublisher({
    accessToken: TOKEN, userId: USER, graphVersion: 'v22.0', publicBaseUrl: '',
    pollIntervalMs: 0, statusAttempts: 3,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/media')) return jsonResponse({ id: '101' });
      if (String(url).includes('fields=status_code')) {
        const polls = calls.filter(call => call.url.includes('fields=status_code')).length;
        return jsonResponse({ status_code: polls === 1 ? 'IN_PROGRESS' : 'FINISHED', id: '101' });
      }
      if (String(url).endsWith('/media_publish')) return jsonResponse({ id: '202' });
      return jsonResponse({ error: { message: 'unexpected' } }, 500);
    }
  });
  const result = await publisher.publish({ caption: 'Posted from Galleypost.', imageUrl: 'https://cdn.example.com/meetup.jpg' });
  assert.equal(result.status, 200);
  assert.equal(result.body.published, true);
  assert.equal(result.body.dryRun, false);
  assert.equal(result.body.mediaId, '202');
  assert.equal(result.body.containerId, '101');
  assert.deepEqual(calls.map(call => call.init.method), ['POST', 'GET', 'GET', 'POST']);
  assert.equal(calls[0].url, 'https://graph.instagram.com/v22.0/17841400000000000/media');
  assert.deepEqual(JSON.parse(calls[0].init.body), { image_url: 'https://cdn.example.com/meetup.jpg', caption: 'Posted from Galleypost.' });
  assert.equal(calls[1].url, 'https://graph.instagram.com/v22.0/101?fields=status_code');
  assert.deepEqual(JSON.parse(calls[3].init.body), { creation_id: '101' });
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.url.includes(TOKEN), false);
    assert.equal(JSON.stringify(call.init.body || '').includes(TOKEN), false);
  }
  assert.equal(JSON.stringify(result.body).includes(TOKEN), false);
});

test('Instagram errors are returned without the access token and without publishing', async () => {
  const calls = [];
  const publisher = createInstagramPublisher({
    accessToken: TOKEN, userId: USER, graphVersion: 'v26.0', pollIntervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/media')) return jsonResponse({ error: { message: `bad token ${TOKEN}` } }, 400);
      return jsonResponse({ id: '999' });
    }
  });
  const result = await publisher.publish({ caption: 'Hello', imageUrl: 'https://cdn.example.com/a.jpg' });
  assert.equal(result.status, 502);
  assert.equal(result.body.published, false);
  assert.match(result.body.error, /bad token \[redacted\]/);
  assert.equal(result.body.error.includes(TOKEN), false);
  assert.equal(calls.some(url => url.endsWith('/media_publish')), false);
});

test('a container that fails processing is not published', async () => {
  const calls = [];
  const publisher = createInstagramPublisher({
    accessToken: TOKEN, userId: USER, graphVersion: 'v26.0', pollIntervalMs: 0,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/media')) return jsonResponse({ id: '303' });
      return jsonResponse({ status_code: 'ERROR', id: '303' });
    }
  });
  const result = await publisher.publish({ caption: 'Hello', imageUrl: 'https://cdn.example.com/a.jpg' });
  assert.equal(result.status, 502);
  assert.match(result.body.error, /ERROR/);
  assert.equal(calls.some(url => url.endsWith('/media_publish')), false);
});

test('local images are hosted only from a public https base, and private URLs are refused', async () => {
  let fetched = false;
  const publisher = createInstagramPublisher({
    accessToken: TOKEN, userId: USER, graphVersion: 'v26.0', publicBaseUrl: 'https://demo.example/app',
    pollIntervalMs: 0,
    fetchImpl: async (url) => {
      fetched = true;
      if (String(url).endsWith('/media')) return jsonResponse({ id: '404' });
      if (String(url).includes('fields=status_code')) return jsonResponse({ status_code: 'FINISHED' });
      if (String(url).endsWith('/media_publish')) return jsonResponse({ id: '505' });
      return jsonResponse({ error: { message: 'unexpected' } }, 500);
    }
  });
  const refused = await publisher.publish({ caption: 'Hello', imageUrl: 'http://127.0.0.1/secret.jpg' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /https/);
  assert.equal(fetched, false);

  const hosted = await publisher.publish({ caption: 'Hello from the studio.', imageData: JPEG_URL });
  assert.equal(hosted.status, 200);
  assert.equal(hosted.body.published, true);
  assert.match(hosted.body.imageUrl, /^https:\/\/demo\.example\/app\/api\/instagram\/media\/[a-f0-9]{32}$/);
  const id = hosted.body.imageUrl.split('/').pop();
  const chunks = [];
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { chunks.push(body); } };
  publisher.serve(res, `/api/instagram/media/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/jpeg');
  assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), JPEG);
});

test('png and non-jpeg uploads explain that Instagram needs a JPEG', async () => {
  const publisher = createInstagramPublisher({ accessToken: '', userId: '', fetchImpl: () => { throw new Error('no fetch'); } });
  const result = await publisher.publish({ caption: 'Hello', imageData: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(result.status, 200);
  assert.match(result.body.imageProblem, /JPEG/);
});

const dryRun = createInstagramPublisher({
  accessToken: '', userId: '', graphVersion: 'v26.0', publicBaseUrl: 'https://demo.example', fetchImpl: () => { throw new Error('no fetch'); }
});
const server = createApp({ instagram: {
  accessToken: '', userId: '', graphVersion: 'v26.0', publicBaseUrl: 'https://demo.example',
  fetchImpl: () => { throw new Error('no fetch'); }
} });
let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('the studio page offers Instagram next to LinkedIn, and the route dry-runs', async () => {
  const page = await fetch(base);
  const html = await page.text();
  assert.match(html, /Post to Instagram/);
  assert.match(html, /Open in Instagram/);
  assert.match(html, /Publish via API/);
  assert.match(html, /Copy caption/);
  assert.match(html, /id="igDialog"/);
  assert.match(html, /id="igOpen"/);
  const status = await (await fetch(`${base}/api/instagram/status`)).json();
  assert.equal(status.dryRun, true);
  assert.equal(status.configured, false);
  assert.equal(JSON.stringify(status).includes('accessToken'), false);
  const preview = await fetch(`${base}/api/instagram/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caption: 'Meetup night.', hasImage: true })
  });
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.equal(body.dryRun, true);
  assert.match(body.requests[0].url, /\/media$/);
  const published = await fetch(`${base}/api/instagram/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ caption: 'Meetup night.', imageData: JPEG_URL })
  });
  assert.equal(published.status, 200);
  const sent = await published.json();
  assert.equal(sent.published, false);
  assert.match(sent.imageUrl, /^https:\/\/demo\.example\/api\/instagram\/media\/[a-f0-9]{32}$/);
  const image = await fetch(sent.imageUrl.replace('https://demo.example', base));
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/jpeg/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), JPEG);
  assert.equal(dryRun.status().publicImageHosting, true);
});

test('hosted images stay reachable without the app password, and publish stays locked', async () => {
  const app = createApp({
    access: { password: 'secret' },
    instagram: { accessToken: '', userId: '', graphVersion: 'v26.0', publicBaseUrl: 'https://demo.example', fetchImpl: () => { throw new Error('no fetch'); } }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${app.address().port}`;
  try {
    const locked = await fetch(`${root}/api/instagram/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ caption: 'Locked.', imageData: JPEG_URL })
    });
    assert.equal(locked.status, 401);
    const authed = await fetch(`${root}/api/instagram/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from('judge:secret').toString('base64')}` },
      body: JSON.stringify({ caption: 'Unlocked dry-run.', imageData: JPEG_URL })
    });
    assert.equal(authed.status, 200);
    const body = await authed.json();
    const image = await fetch(body.imageUrl.replace('https://demo.example', root));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('www-authenticate'), null);
  } finally { app.close(); }
});

test('publish refuses a cross-origin browser and a non-JSON body', async () => {
  const cross = await fetch(`${base}/api/instagram/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ caption: 'Nope' })
  });
  assert.equal(cross.status, 403);
  const text = await fetch(`${base}/api/instagram/publish`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'nope' });
  assert.equal(text.status, 415);
});
