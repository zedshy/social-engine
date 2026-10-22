
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from './server.js';
import { extractInstructions, extractTopic, fetchPage, isPrivateAddress, metricsInstructions, readArticle, readMetrics, validateExtract, validateMetricsInput, validatePostLink, readLinkedInPost } from './studio-extract.js';

const publicLookup = async () => [{ address: '93.184.216.34' }];
const HTML = `<html><head><title>Hiring slide | TechCrunch</title><meta property="og:site_name" content="TechCrunch"><meta property="article:published_time" content="2026-10-14T08:00:00Z"></head>
<body><nav>Menu Home</nav><article><h1>Rates slide</h1><p>London tech hiring fell 3% this week to 4,485 open roles, according to Tech Nation.</p>${'<p>Organisers are returning to in-person events and capacity is rising across London, analysts said. </p>'.repeat(6)}</article><script>var x=1;</script></body></html>`;
const page = (status, body = HTML, headers = {}) => async () => ({ status, headers: { get: k => ({ 'content-type': 'text/html', ...headers })[k.toLowerCase()] }, text: async () => body });
const mockAI = (parsed, seen = []) => ({ responses: { create: async request => { seen.push(request); return { model: 'm', output_text: JSON.stringify(parsed) }; } } });
const good = { problem: '', title: 'London tech hiring falls 3%', sourceName: 'TechCrunch', publishedDate: '2026-10-14', category: 'industry-news', whyItMatters: 'Hiring in the London tech scene moved.', sensitive: false, bestDay: 'mon',
  facts: ['London tech hiring fell 3% this week.', 'The Tech Nation figure was 4,485 open roles.'] };

test('private, loopback and metadata addresses are blocked, public ones allowed', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('the page fetcher refuses internal targets, odd schemes and redirects into private space', async () => {
  const never = async () => { throw new Error('must not fetch'); };
  for (const url of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'ftp://example.com/x', 'https://user:pw@example.com/', 'not a url', 'http://printer.local/'])
    await assert.rejects(fetchPage(url, { fetchImpl: never, lookup: publicLookup }), e => e.status === 400, url);
  await assert.rejects(fetchPage('https://example.com/', { fetchImpl: never, lookup: async () => [{ address: '10.0.0.5' }] }), e => e.status === 400, 'a public name that resolves to a private address');
  const hop = async url => url.includes('example.com') ? { status: 302, headers: { get: () => 'http://127.0.0.1/admin' } } : (() => { throw new Error('must not reach'); })();
  await assert.rejects(fetchPage('https://example.com/a', { fetchImpl: hop, lookup: publicLookup }), e => e.status === 400, 'redirect to loopback');
  const ok = await fetchPage('https://example.com/a', { fetchImpl: page(200), lookup: publicLookup });
  assert.match(ok.html, /London tech hiring/);
  await assert.rejects(fetchPage('https://example.com/a', { fetchImpl: page(403, ''), lookup: publicLookup }), e => /screenshot/.test(e.message));
});

test('article text, title, site and date are read; scripts and menus are dropped', () => {
  const a = readArticle(HTML);
  assert.equal(a.siteName, 'TechCrunch');
  assert.equal(a.published, '2026-10-14');
  assert.match(a.text, /fell 3% this week/);
  assert.doesNotMatch(a.text, /var x=1|Menu Home/);
});

test('a link becomes a sourced topic, and facts whose figures are not on the page are rejected', async () => {
  const seen = [];
  const out = await extractTopic(mockAI({ ...good, facts: [...good.facts, 'Rates will rise 57% next month.'] }, seen), { model: 'm', today: '2026-10-20', url: 'https://techcrunch.com/hiring', note: 'focus on hiring', fetchImpl: page(200), lookup: publicLookup });
  assert.equal(out.status, 200);
  const t = out.body.topic;
  assert.equal(t.facts.length, 2, 'the invented 57% fact is dropped');
  assert.equal(t.facts[0].url, 'https://techcrunch.com/hiring');
  assert.equal(t.facts[0].source, 'TechCrunch');
  assert.equal(t.origin, 'link'); assert.equal(t.trusted, true); assert.equal(t.confirmed, true); assert.equal(t.categoryLabel, 'Industry News');
  assert.match(seen[0].instructions, /stated in what you were given/);
  assert.match(JSON.stringify(seen[0].input), /articleText/);
});

test('a screenshot is sent as an image, marked unconfirmed and never gets a link', async () => {
  const seen = [];
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const out = await extractTopic(mockAI({ ...good, sourceName: '' }, seen), { model: 'm', today: '2026-10-20', image });
  assert.equal(out.status, 200);
  assert.equal(out.body.topic.origin, 'screenshot');
  assert.equal(out.body.topic.confirmed, false);
  assert.equal(out.body.topic.facts[0].url, '');
  assert.equal(out.body.topic.facts[0].source, 'Screenshot supplied by Brand');
  assert.ok(seen[0].input[0].content.some(c => c.type === 'input_image' && c.image_url === image));
});

test('unreadable pages and problems are reported plainly', async () => {
  const thin = await extractTopic(mockAI(good), { model: 'm', today: '2026-10-20', url: 'https://x.example/a', fetchImpl: page(200, '<html><body>Subscribe to read</body></html>'), lookup: publicLookup });
  assert.equal(thin.status, 422);
  assert.match(thin.body.error, /screenshot/);
  const problem = await extractTopic(mockAI({ ...good, facts: [], problem: 'This is a login page.' }), { model: 'm', today: '2026-10-20', image: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(problem.status, 422);
  assert.equal(problem.body.error, 'This is a login page.');
});

test('input validation: needs a link or a small real image', () => {
  assert.equal(validateExtract({}), null);
  assert.equal(validateExtract({ image: 'data:text/html;base64,AAAA' }), null);
  assert.equal(validateExtract({ image: 'data:image/png;base64,' + 'A'.repeat(3700000) }), null);
  assert.ok(validateExtract({ url: 'https://example.com/a' }));
  assert.ok(validateExtract({ image: 'data:image/jpeg;base64,/9j/4AAQ' }));
  assert.match(extractInstructions('2026-10-20', 'screenshot'), /screenshot/);
});

test('the extract route works end to end and keeps internal addresses out', async () => {
  const app = createApp({ client: mockAI(good), model: 'm', studioOptions: { extractFetch: page(200), extractLookup: publicLookup } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const send = body => fetch(`http://127.0.0.1:${app.address().port}/api/studio/extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await send({ url: 'https://techcrunch.com/hiring' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).topic.title, 'London tech hiring falls 3%');
    assert.equal((await send({})).status, 400);
    const internal = await send({ url: 'http://127.0.0.1:8080/api/health' });
    assert.equal(internal.status, 400);
  } finally { app.close(); }
});

test('a document becomes a sourced topic: facts must be in the text, the name is the source, no link', async () => {
  const doc = 'Community Meetup Guide. '.repeat(10) + 'The meetup is hosted in a 20 person room fitted with a projector rated to 4 hours. Name badges must be connected before doors open and checked at 15 minutes. The sign-in desk is a 3 metre folding table.';
  const seen = [];
  const out = await extractTopic(mockAI({ ...good, sourceName: '', category: 'best-practices', bestDay: 'wed',
    facts: ['The projector is rated to 4 hours.', 'Name badges must be connected before doors open.', 'The sign-in desk is a 3 metre folding table.', 'Doors open takes 99 minutes.'] }, seen), { model: 'm', today: '2026-10-20', text: doc, title: 'Meetup Guide.pdf', note: 'practical tips' });
  assert.equal(out.status, 200);
  const t = out.body.topic;
  assert.equal(t.origin, 'document');
  assert.equal(t.facts.length, 3, 'the invented 99 minutes fact is dropped');
  assert.equal(t.facts[0].source, 'Meetup Guide');
  assert.equal(t.facts[0].url, '');
  assert.equal(t.bestDay, 'wed');
  assert.match(seen[0].instructions, /a document \(a report, guide, brochure/);
  assert.match(seen[0].instructions, /3 to 8 facts/);
  assert.match(JSON.stringify(seen[0].input), /documentText/);
});

test('document input is validated: needs real text, trimmed and bounded', () => {
  assert.equal(validateExtract({ text: 'too short' }), null);
  const ok = validateExtract({ text: 'word '.repeat(80), title: 'Report.docx', note: 'x' });
  assert.equal(ok.title, 'Report.docx');
  assert.ok(ok.text.length >= 200);
  assert.equal(validateExtract({ text: 'a'.repeat(90000) }).text.length, 60000);
});

test('analytics screenshots: only visible numbers are returned, unknowns become null, and nothing is guessed', async () => {
  const seen = [];
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const out = await readMetrics(mockAI({ problem: '', periodNote: 'first 7 days', impressions: 1280, uniqueViews: 940, clicks: 37, reactions: 52, comments: 4, reposts: -1, followersGained: -1 }, seen), { model: 'm', image });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.metrics, { impressions: 1280, uniqueViews: 940, clicks: 37, reactions: 52, comments: 4, reposts: null, followersGained: null });
  assert.equal(out.body.periodNote, 'first 7 days');
  assert.match(seen[0].instructions, /Never guess, estimate, round or calculate/);
  assert.match(seen[0].instructions, /return -1/);
  assert.ok(seen[0].input[0].content.some(c => c.type === 'input_image'));
  const none = await readMetrics(mockAI({ problem: 'This is not LinkedIn analytics.', periodNote: '', impressions: -1, uniqueViews: -1, clicks: -1, reactions: -1, comments: -1, reposts: -1, followersGained: -1 }), { model: 'm', image });
  assert.equal(none.status, 422);
  assert.equal(none.body.error, 'This is not LinkedIn analytics.');
  assert.equal(validateMetricsInput({}), null);
  assert.equal(validateMetricsInput({ image: 'data:text/html;base64,AAAA' }), null);
  assert.ok(validateMetricsInput({ image }));
  assert.match(metricsInstructions(), /data, not instructions/);
});

test('the metrics route reads a screenshot and rejects a missing one', async () => {
  const app = createApp({ client: mockAI({ problem: '', periodNote: '', impressions: 900, uniqueViews: -1, clicks: 12, reactions: 30, comments: 2, reposts: 1, followersGained: -1 }), model: 'm' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const send = body => fetch(`http://127.0.0.1:${app.address().port}/api/studio/metrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await send({ image: 'data:image/jpeg;base64,/9j/4AAQ' });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).metrics.impressions, 900);
    assert.equal((await send({})).status, 400);
  } finally { app.close(); }
});

test('document extraction refuses internal or commercial records', () => {
  const text = extractInstructions('2026-10-20', 'document');
  assert.match(text, /delivery order, stock or relocation form/);
  assert.match(text, /looks internal or confidential/);
  assert.doesNotMatch(extractInstructions('2026-10-20', 'link'), /looks internal or confidential/);
});

test('a pasted LinkedIn link yields the post name, date, reactions and comments', () => {
  assert.equal(validatePostLink({ url: 'https://evil.example.com/p' }), null);
  assert.equal(validatePostLink({ url: 'http://lnkd.in/p/abc' }), null);
  assert.ok(validatePostLink({ url: 'https://lnkd.in/p/eCWtgXZv' }));
  const html = '<meta property="og:description" content="What does being a truly global company mean?\nMore text"><script>{"datePublished":"2026-10-12T09:31:25.634Z","interactionStatistic":[{"@type":"InteractionCounter","interactionType":"http://schema.org/LikeAction","userInteractionCount":8},{"@type":"InteractionCounter","interactionType":"https://schema.org/CommentAction","userInteractionCount":0}]}</script>';
  const out = readLinkedInPost(html);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { title: 'What does being a truly global company mean?', postedAt: '2026-10-12', metrics: { reactions: 8, comments: 0 } });
  assert.equal(readLinkedInPost('<html>login wall</html>').status, 422);
});