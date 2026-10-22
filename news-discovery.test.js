
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { NEWS_SOURCES, parseFeed, selectArticles, createNewsDiscovery } from './news-discovery.js';
import { createApp } from './server.js';

const now = Date.parse('2026-10-19T12:00:00Z');
const source = NEWS_SOURCES[0];
const rss = entries => `<?xml version="1.0"?><rss version="2.0"><channel>${entries}</channel></rss>`;
const item = (title = 'New hackathon announced', link = 'https://techcrunch.com/news/', date = 'Mon, 19 Oct 2026 07:00:00 GMT') =>
  `<item><title><![CDATA[${title}]]></title><link>${link.replaceAll('&', '&amp;')}</link><pubDate>${date}</pubDate><description>Do not return this summary</description><content:encoded xmlns:content="urn:content">Restricted article body</content:encoded></item>`;
const response = xml => new Response(xml, { headers: { 'content-type': 'application/rss+xml' } });

test('RSS parsing keeps metadata, decodes entities and omits all article content', () => {
  const parsed = parseFeed(rss(item('startups &amp; open source')), source);
  assert.equal(parsed[0].title, 'startups &amp; open source'); // CDATA is literal text
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['publishedAt', 'title', 'url']);
  assert.doesNotMatch(JSON.stringify(parsed), /Restricted|summary/);
  assert.equal(parseFeed(rss('<item><title>Hackathons &amp; meetups</title></item>'), source)[0].title, 'Hackathons & meetups');
});

test('Atom supports namespaces, alternate links, publication dates and CDATA', () => {
  const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>London startups</title><link rel="self" href="https://techcrunch.com/api/1"/><link rel="alternate" href="https://techcrunch.com/story/"/><published>2026-10-18T10:00:00Z</published><content type="html">Private content</content></entry></feed>';
  const parsed = parseFeed(xml, source);
  assert.equal(parsed[0].url, 'https://techcrunch.com/story/');
  assert.equal(parsed[0].publishedAt, '2026-10-18T10:00:00Z');
  assert.equal(selectArticles(parsed, now)[0].score, 6);
});

test('rejects malformed XML, HTML, DTDs and oversized feeds', () => {
  for (const xml of ['<rss><channel>', '<html><body>Blocked</body></html>', '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>', 'x'.repeat(2097153)]) {
    assert.throws(() => parseFeed(xml, source));
  }
});

test('deduplicates tracked URLs and headlines, excludes stale/invalid/future dates and unsafe links, ranks relevance', () => {
  const xml = rss(item('General headlines', 'https://techcrunch.com/general/') +
    item('New hackathon announced', 'https://techcrunch.com/news/?utm_source=email#top') +
    item('Same link, new title', 'https://techcrunch.com/news/') +
    item('New hackathon announced!', 'https://techcrunch.com/duplicate/') +
    item('Old products', 'https://techcrunch.com/old/', '1 Jan 2025 00:00:00 GMT') +
    item('Unknown date', 'https://techcrunch.com/unknown/', '') +
    item('Future products', 'https://techcrunch.com/future/', '1 Jan 2027 00:00:00 GMT') +
    item('Bad protocol', 'javascript:alert(1)') + item('Wrong host', 'https://evil.example/story') +
    item('Missing link', ''));
  const selected = selectArticles(parseFeed(xml, source), now);
  assert.equal(selected.length, 2);
  const ranked = selected.find(a => a.title === 'New hackathon announced');
  const other = selected.find(a => a.title === 'General headlines');
  assert.equal(ranked.url, 'https://techcrunch.com/news/');
  assert.equal(other.score, 0);
});

test('partial failures, empty feeds, disabled sources, coalescing and cache expiry remain explicit', async () => {
  let clock = now; const urls = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const discover = createNewsDiscovery({ now: () => clock, fetchImpl: async url => {
    urls.push(url); await gate;
    if (url === source.feed) return response(rss(item()));
    if (url.includes('theverge')) throw new Error('Network failed');
    return response(rss(''));
  } });
  const first = discover(), second = discover(); release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(urls.length, 4);
  assert.ok(!urls.some(url => url.includes('ycombinator')));
  assert.deepEqual(a.sources.map(s => s.status), ['ok', 'failed', 'restricted', 'empty', 'empty']);
  assert.equal(a.kind, 'live'); assert.equal(a.articles.length, 1);
  assert.equal((await discover()).cached, true); assert.equal(urls.length, 4);
  clock += 600001; assert.equal((await discover()).cached, false); assert.equal(urls.length, 8);
});

test('all failed feeds return no invented results; timeouts and response limits are bounded', async () => {
  const timed = createNewsDiscovery({ now: () => now, timeoutMs: 5, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }) });
  const result = await timed();
  assert.equal(result.articles.length, 0);
  assert.equal(result.sources.filter(s => s.status === 'failed').length, 4);
  assert.match(result.sources[0].error, /timed out/);
  for (const makeResponse of [() => response('x'.repeat(2097153)), () => new Response('Blocked', { status: 403 }), () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })]) {
    const discover = createNewsDiscovery({ now: () => now, fetchImpl: async (url, options) => {
      assert.equal(options.redirect, 'error'); return makeResponse();
    } });
    assert.equal((await discover()).sources[0].status, 'failed');
  }
});

test('populated but outdated or undated feeds report no eligible recent items', async () => {
  const discover = createNewsDiscovery({ now: () => now, fetchImpl: async () => response(rss(item('Old', source.website, '1 Jan 2024'))) });
  const result = await discover();
  assert.equal(result.articles.length, 0);
  assert.equal(result.sources[0].status, 'no-recent-items');
});

test('Sifted uses its populated official European startup feed', async () => {
  const sifted = NEWS_SOURCES.find(s => s.id === 'sifted');
  assert.equal(sifted.feed, 'https://sifted.eu/feed/');
  const requests = [];
  const discover = createNewsDiscovery({ now: () => now, fetchImpl: async url => {
    requests.push(url);
    return url === sifted.feed
      ? response(rss(item('London startups join a climate tech hackathon', 'https://sifted.eu/example-news/', 'Mon, 19 Oct 2026 07:00:00 GMT')))
      : response(rss(''));
  } });
  const result = await discover();
  assert.ok(requests.includes(sifted.feed));
  assert.ok(!requests.includes('https://sifted.eu/news-articles/feed/'));
  const publication = result.sources.find(s => s.id === sifted.id);
  assert.equal(publication.status, 'ok'); assert.equal(publication.eligible, 1);
  assert.equal(result.articles.find(a => a.sourceId === sifted.id).title, 'London startups join a climate tech hackathon');
});

test('HTTP news endpoint works without an API key and never calls AI', async t => {
  const server = createApp({ client: { responses: { create() { assert.fail('News must not call AI'); } } }, newsOptions: {
    now: () => now, fetchImpl: async () => response(rss(item()))
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/api/news'); assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).kind, 'live');
  assert.equal((await fetch(base + '/api/news', { method: 'POST' })).status, 405);
});

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 30));
function page(t, fetchImpl, saved) {
  const errors = []; const vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8081', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {} });
      window.scrollTo = () => {}; window.fetch = fetchImpl;
      if (saved) window.localStorage.setItem('sse-post-library-v1', saved);
    } });
  t.after(() => dom.window.close());
  return { dom, errors, byId: id => dom.window.document.getElementById(id) };
}
const live = { kind: 'live', checkedAt: new Date(now).toISOString(), nextCheckAt: new Date(now + 600000).toISOString(),
  articles: [
    { title: 'New hackathon announced <img src=x onerror=alert(1)>', source: source.name, sourceId: source.id, publishedAt: new Date(now).toISOString(), url: source.website + 'news/', score: 10, matches: ['hackathons'] },
    { title: 'Broader tech news', source: 'Ars Technica', sourceId: 'arstechnica', publishedAt: new Date(now).toISOString(), url: 'https://arstechnica.com/news/', score: 0, matches: [] }
  ], sources: NEWS_SOURCES.map(s => ({ ...s, status: s.disabled ? 'restricted' : 'ok' })) };

test('news tab loads lazily, filters sources and relevance, escapes headlines and preserves dated results on failure', async t => {
  let calls = 0;
  const p = page(t, async url => { assert.equal(url, '/api/news'); calls++; if (calls > 1) throw new Error('Offline'); return { ok: true, json: async () => live }; });
  assert.equal(calls, 0); p.byId('tab-news').click(); await wait();
  assert.equal(calls, 1); assert.equal(p.byId('p-news').hidden, false);
  assert.equal(p.byId('newsResults').querySelectorAll('article').length, 1);
  assert.equal(p.byId('newsResults').querySelectorAll('img').length, 0);
  assert.match(p.byId('newsStatus').textContent, /Live RSS/);
  const scope = p.byId('newsScope'); scope.value = 'all'; scope.dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(p.byId('newsResults').querySelectorAll('article').length, 2);
  const filter = p.byId('newsSource'); filter.value = 'arstechnica'; filter.dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(p.byId('newsResults').querySelectorAll('article').length, 1);
  p.byId('newsRefresh').click(); await wait();
  assert.match(p.byId('newsStatus').textContent, /Previous RSS results remain/);
  assert.equal(p.byId('newsRefresh').disabled, false);
  assert.deepEqual(p.errors, []);
});

test('initial failure substitutes no sample articles and a later retry can recover', async t => {
  let calls = 0;
  const p = page(t, async () => { calls++; return calls === 1 ? { ok: false } : { ok: true, json: async () => ({ ...live, articles: [] }) }; });
  p.byId('tab-news').click(); await wait();
  assert.match(p.byId('newsStatus').textContent, /no sample data is substituted/);
  assert.equal(p.byId('newsResults').children.length, 0);
  p.byId('newsRefresh').click(); await wait();
  assert.match(p.byId('newsResults').textContent, /No recent headlines/);
  assert.deepEqual(p.errors, []);
});


test('publisher AI analysis and researched demo paths are absent from the integration build', async t => {
  const server = createApp({ apiKey: 'test-key', client: { responses: { create() { assert.fail('News must not call AI'); } } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/api/news/analyse');
  assert.equal(response.status, 404);
  const html = await (await fetch(base + '/classic')).text();
  for (const excluded of ['newsResearchExample', 'newsResearchUseInEngine', 'newsLocalTestAnalyze', 'newsRealTestAnalyze', 'Analyse five real developments', 'OIV, State of the World Wine Sector', 'Damien McClean', 'DHL', 'LAF']) {
    assert.equal(html.includes(excluded), false, 'Unexpected excluded UI/content: ' + excluded);
  }
  assert.equal(html.includes('Generate Posts'), true);
  assert.equal(html.includes('weeklySourceMonday'), true);
});