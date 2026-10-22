
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './server.js';
import { chatInstructions, chatTurn, validateChat, checkFact, verifySources, cleanTopics, findTopics, findTopicsMulti, mergeTopics, lintPost, postInstructions, topicsInstructions, verifyInstructions, writePost } from './studio-content.js';

const FACT = { text: 'Organisers are tentatively returning to in-person events across London.', source: 'Reuters', url: 'https://reuters.com/london-tech', date: '2026-10-01' };
const topic = { title: 'Organisers return to in-person events', sensitive: false, facts: [FACT] };

function mock({ searched = true, topics, drafts = [], checks = [], throwOnTools } = {}) {
  const calls = [];
  let d = 0, c = 0;
  return { calls, responses: { create: async (request) => {
    calls.push(request);
    const name = request.text.format.name;
    if (name === 'topic_ideas') {
      if (throwOnTools) throw Object.assign(new Error('unsupported'), { status: 400 });
      return { status: 'completed', model: 'm', output: [
        ...(searched ? [{ type: 'web_search_call' }] : []),
        { type: 'message', content: [{ annotations: [{ type: 'url_citation', url: 'https://techcrunch.com/other-page' }] }] }],
      output_text: JSON.stringify({ topics }) };
    }
    if (name === 'fact_check') return { output_text: JSON.stringify({ unsupported: checks[c++] ?? [] }) };
    return { model: 'm', output_text: JSON.stringify(drafts[Math.min(d++, drafts.length - 1)]) };
  } } };
}
const draft = (post, extra = {}) => ({ post, headline: 'Meetups reopen', hashtags: ['Community'], visual: 'A meetup in a co-working space', scene: 'event', toCheck: [], ...extra });
const GOOD = 'Organisers are tentatively returning to in-person events.\n\nAccording to Reuters, organisers are tentatively returning to in-person events across London. The report describes the move as tentative and says it applies to meetups and hackathons, which is the format most affected by the shift to hybrid rooms over recent months.\n\nFor community organisers tracking venues and attendance on those nights, the reporting is worth watching closely as calendars are confirmed. These venue decisions have implications for newcomers and volunteer capacity.\n\nHow are you planning around the calendar changes?';

test('research prompt demands recent, sourced, searched topics and flags sensitive news', () => {
  const text = topicsInstructions('2026-10-20');
  assert.match(text, /Today is 2026-10-20/);
  assert.match(text, /last 30 days/);
  assert.match(text, /exact URL of that specific article/);
  assert.match(text, /sensitive to true/);
  assert.match(text, /bestDay/);
  assert.match(text, /industry-news|trends|best-practices|community/);
});

const NOW = Date.parse('2026-10-20');

test('topics are cleaned: bad categories, unsafe links, stale news and unsourced facts are dropped', () => {
  const cleaned = cleanTopics({ topics: [
    { title: 'Good', category: 'industry-news', whyItMatters: 'Matters.', affectsTargetAudience: true, sensitive: false, bestDay: 'wed', facts: [FACT, { ...FACT, url: 'javascript:alert(1)' }, { ...FACT, source: '' }] },
    { title: 'Bad category', affectsTargetAudience: true, category: 'gossip', whyItMatters: 'x', sensitive: false, facts: [FACT] },
    { title: 'Stale news', affectsTargetAudience: true, category: 'trends', whyItMatters: 'x', sensitive: false, facts: [{ ...FACT, date: '2026-06-01' }] },
    { title: 'Undated news', affectsTargetAudience: true, category: 'trends', whyItMatters: 'x', sensitive: false, facts: [{ ...FACT, date: '' }] },
    { title: 'Old but authoritative guide', affectsTargetAudience: true, category: 'best-practices', whyItMatters: 'x', sensitive: false, facts: [{ ...FACT, url: 'https://developer.mozilla.org/guide', source: 'MDN', date: '2025-03-01' }] },
    { title: 'Homepage only', affectsTargetAudience: true, category: 'industry-news', whyItMatters: 'x', sensitive: false, facts: [{ ...FACT, url: 'https://techcrunch.com/' }] },
    { title: 'Index page', affectsTargetAudience: true, category: 'industry-news', whyItMatters: 'x', sensitive: false, facts: [{ ...FACT, url: 'https://www.theverge.com/index' }] },
    { title: 'Vendor blog', affectsTargetAudience: true, category: 'industry-news', whyItMatters: 'x', sensitive: false, facts: [{ ...FACT, url: 'https://some-vendor.example/blog/our-take-on-events' }] }
  ] }, { now: NOW });
  const byTitle = title => cleaned.find(t => t.title === title);
  assert.deepEqual(new Set(cleaned.map(t => t.title)), new Set(['Good', 'Old but authoritative guide', 'Vendor blog']));
  assert.equal(byTitle('Good').facts.length, 1);
  assert.ok(!cleaned.some(t => ['Homepage only', 'Index page'].includes(t.title)));
  assert.equal(byTitle('Good').trusted, true);
  assert.equal(byTitle('Good').bestDay, 'wed');
  assert.equal(byTitle('Old but authoritative guide').bestDay, 'mon', 'unknown day defaults safely');
  assert.equal(byTitle('Old but authoritative guide').evergreen, true);
  assert.equal(byTitle('Vendor blog').trusted, false);
  assert.equal(byTitle('Vendor blog').facts[0].tier, 'check');
  assert.equal(byTitle('Good').categoryLabel, 'Industry News');
});

test('irrelevant, duplicate and tracked topics are cleaned up', () => {
  const base = { category: 'trends', whyItMatters: 'x', sensitive: false, bestDay: 'fri', affectsTargetAudience: true };
  const f = (url, text = FACT.text) => ({ ...FACT, url, text, date: '2026-10-10' });
  const cleaned = cleanTopics({ topics: [
    { ...base, title: 'Tech industry trends flood the market', facts: [f('https://latimes.com/business/story/2026-10-07/tech?utm_source=x&lctg=abc&id=7'), f('https://latimes.com/business/story/2026-10-07/tech?id=7', 'b'), f('https://latimes.com/business/story/2026-10-07/tech?id=7', 'c'), f('https://latimes.com/business/story/2026-10-07/tech?id=7', 'd')] },
    { ...base, title: 'Tech industry trends reach the market', facts: [f('https://techreport.com/trends-2026')] },
    { ...base, title: 'FTC settles with distributor', affectsTargetAudience: false, facts: [f('https://apnews.com/article/1')] },
    { ...base, title: 'Tech exports fall 11.8%', facts: [f('https://techcrunch.com/news/fullstory.php/aid/1')] }
  ] }, { now: NOW });
  assert.deepEqual(new Set(cleaned.map(t => t.title)), new Set(['Tech industry trends flood the market', 'Tech exports fall 11.8%']));
  assert.equal(cleaned[0].facts.length, 3, 'at most three facts per link');
  assert.ok(cleaned[0].facts.every(x => !/utm_|lctg/.test(x.url)));
  assert.match(cleaned[0].facts[0].url, /id=7/, 'real article ids survive');
});

test('a topic whose facts never match profile keywords is dropped even if the model says it is relevant', () => {
  const profile = { research: { categories: { 'industry-news': 'Industry News' }, keywords: ['shipping', 'logistics', 'freight'] } };
  const f = { ...FACT, text: 'The FTC settled with Southern Glazer\'s over discriminatory pricing to smaller retailers.', url: 'https://apnews.com/article/1', date: '2026-10-02' };
  const out = cleanTopics({ topics: [{ title: 'FTC settles with distributor', category: 'industry-news', whyItMatters: 'x', affectsTargetAudience: true, sensitive: false, bestDay: 'mon', facts: [f] }] }, { now: NOW, profile });
  assert.equal(out.length, 0);
});

test('the fact-checker is told to be accurate not pedantic, and focus narrows the search', () => {
  assert.match(verifyInstructions(), /not pedantic/);
  assert.match(verifyInstructions(), /publication date/);
  assert.match(topicsInstructions('2026-10-20', 'London hackathons'), /London hackathons/);
  assert.doesNotMatch(topicsInstructions('2026-10-20'), /The user wants topics about/);
});

test('findTopics refuses to guess without live search', async () => {
  const none = await findTopics(mock({ searched: false, topics: [] }), { model: 'm', today: '2026-10-20' });
  assert.equal(none.status, 503);
  const unsupported = await findTopics(mock({ throwOnTools: true }), { model: 'm', today: '2026-10-20' });
  assert.equal(unsupported.status, 503);
  const ok = await findTopics(mock({ topics: [{ title: 'T', affectsTargetAudience: true, category: 'industry-news', whyItMatters: 'W', sensitive: false, facts: [FACT] }] }), { model: 'm', today: '2026-10-20', now: NOW, fetchImpl: null });
  assert.equal(ok.status, 200);
  const found = ok.body.topics.find(t => t.title === 'T');
  assert.equal(found.facts[0].tier, 'trusted');
});

test('a clean draft is verified once and returned with sources', async () => {
  const client = mock({ drafts: [draft(GOOD)] });
  const out = await writePost(client, { model: 'm', topic, day: 'mon', prior: [] });
  assert.equal(out.status, 200);
  assert.equal(out.body.verified, true);
  assert.equal(out.body.rewritten, false);
  assert.equal(out.body.lint.length, 0, out.body.lint.join('; '));
  assert.deepEqual(out.body.sources, [{ source: 'Reuters', url: 'https://reuters.com/london-tech' }]);
  assert.equal(client.calls.length, 2);
});

test('unsupported sentences trigger one rewrite and a second check', async () => {
  const claim = 'This will significantly cut transit costs.';
  const client = mock({ drafts: [draft(`${GOOD}\n\n${claim}`), draft(GOOD)], checks: [[{ sentence: claim, reason: 'Not in the facts' }], []] });
  const out = await writePost(client, { model: 'm', topic, day: 'mon', prior: [] });
  assert.equal(out.body.rewritten, true);
  assert.equal(out.body.verified, true);
  assert.doesNotMatch(out.body.post, /transit costs|turnaround costs/);
  assert.match(client.calls[2].instructions, /unsupported sentences/);
  assert.deepEqual(JSON.parse(client.calls[2].input).unsupportedSentences, [claim]);
});

test('claims that survive the rewrite are surfaced to check, never hidden', async () => {
  const claim = 'Rates will fall further.';
  const client = mock({ drafts: [draft(`${GOOD}\n\n${claim}`), draft(`${GOOD}\n\n${claim}`)], checks: [[{ sentence: claim, reason: 'Forecast' }], [{ sentence: claim, reason: 'Forecast' }]] });
  const out = await writePost(client, { model: 'm', topic, day: 'wed', prior: [] });
  assert.equal(out.body.verified, false);
  assert.ok(out.body.toCheck.some(c => c.startsWith(claim) && /Forecast/.test(c)), 'the checker\'s reason travels with the flag');
});

test('writer prompt carries the slot role, hook rule, sensitivity and no-repeat rule', () => {
  const mon = postInstructions('mon', false), fri = postInstructions('fri', true);
  assert.match(mon, /Monday/); assert.match(mon, /Industry news/);
  assert.match(fri, /Friday/); assert.match(fri, /sensitive/);
  assert.match(mon, /at most 15 words/);
  assert.match(mon, /directly stated in/);
  assert.match(mon, /Do not repeat the opening/);
  assert.match(mon, /Never invent statistics/);
  assert.match(mon, /14 October/);
  assert.doesNotMatch(mon, /sensitive\. Use a neutral/);
});

test('lint catches hype, emoji, prices, hashtags in text, missing source and bad length', () => {
  const warnings = lintPost('This game-changer 🚀 costs $500 #Shipping', [FACT], ['a', 'b', 'c', 'd']);
  assert.ok(warnings.some(w => /Length/.test(w)));
  assert.ok(warnings.some(w => /Hashtags belong/.test(w)));
  assert.ok(warnings.some(w => /three hashtags/.test(w)));
  assert.ok(warnings.some(w => /name its source/.test(w)));
  assert.ok(warnings.filter(w => /Avoid wording/.test(w)).length >= 2);
  assert.ok(!lintPost(`${GOOD} Rates held at $71.47 per tonne.`, [FACT]).some(w => /Avoid wording/.test(w)), 'market figures are allowed');
});

let server, base;
before(async () => {
  const client = mock({ topics: [{ title: 'T', affectsTargetAudience: true, category: 'industry-news', whyItMatters: 'W', sensitive: false, facts: [FACT] }], drafts: [draft(GOOD)] });
  server = createApp({ client, model: 'test-model', studioOptions: { fetchImpl: async () => ({ status: 200, headers: { get: () => 'text/html' }, text: async () => 'Organisers are tentatively returning to in-person events' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('topics and post routes work end to end and validate input', async () => {
  const topics = await (await post('/api/studio/topics', {})).json();
  const chosen = (topics.topics || []).find(t => t.title === 'T') || (topics.topics || [])[0];
  assert.ok(chosen === undefined || chosen.title === 'T');
  const ok = await post('/api/studio/post', { day: 'mon', topic: chosen });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).verified, true);
  assert.equal((await post('/api/studio/post', { day: 'sun', topic: chosen })).status, 400);
  assert.equal((await post('/api/studio/post', { day: 'mon', topic: { title: 'No facts', facts: [] } })).status, 400);
  const options = await (await fetch(`${base}/api/studio/options`)).json();
  assert.deepEqual(options.days.map(d => d.id), ['mon', 'wed', 'fri']);
});

test('one rotating search by default, cached for the day', async () => {
  let calls = 0;
  const client = { responses: { create: async () => { calls++; return { model: 'm', output: [{ type: 'web_search_call' }],       output_text: JSON.stringify({ topics: [{ title: 'Meetup return', category: 'trends', whyItMatters: 'x', affectsTargetAudience: true, sensitive: false, bestDay: 'mon', facts: [{ ...FACT, url: 'https://techcrunch.com/a', date: '2026-10-10' }] }] }) }; } } };
  const cache = new Map(), opts = { model: 'm', today: '2026-10-20', now: NOW, fetchImpl: null, cache };
  const first = await findTopicsMulti(client, { ...opts, round: 0 });
  assert.equal(first.body.searches, 1);
  assert.equal(calls, 1);
  const again = await findTopicsMulti(client, { ...opts, round: 0 });
  assert.equal(again.body.searchesCached, 1);
  assert.equal(calls, 1, 'second run is served from the cache');
  const seen = await findTopicsMulti(client, { ...opts, round: 0, exclude: ['Meetup return'] });
  assert.equal(seen.status, 502, 'cached topics already shown are not repeated');
  await findTopicsMulti(client, { ...opts, round: 0, fresh: true });
  assert.equal(calls, 2, 'fresh bypasses the cache');
  await findTopicsMulti(client, { ...opts, round: 1 });
  assert.equal(calls, 3, 'the next click searches a different area');
});

test('three focused searches run, merge, drop repeated stories and survive one failing', async () => {
  const mk = (title, category, url) => ({ title, category, whyItMatters: 'x', affectsTargetAudience: true, sensitive: false, bestDay: 'mon',
    facts: [{ ...FACT, url, date: '2026-10-10', text: 'Meetup attendance on London routes fell.' }] });
  const focusSeen = [];
  let n = 0;
  const client = { responses: { create: async (request) => {
    focusSeen.push(JSON.parse(request.input).focus);
    n += 1;
    if (n === 2) throw Object.assign(new Error('boom'), { status: 500 });
    const topics = n === 1 ? [mk('Meetup return fills rooms again', 'trends', 'https://techcrunch.com/a')]
      : [mk('Meetup return fills rooms again', 'trends', 'https://sifted.eu/b'), mk('Venue strike hits Shoreditch', 'industry-news', 'https://techcrunch.com/c')];
    return { model: 'm', output: [{ type: 'web_search_call' }], output_text: JSON.stringify({ topics }) };
  } } };
  const out = await findTopicsMulti(client, { model: 'm', today: '2026-10-20', now: NOW, fetchImpl: null, all: true });
  assert.equal(out.status, 200);
  assert.equal(out.body.searches, 3);
  assert.equal(out.body.searchesSucceeded, 2);
  const titles = out.body.topics.map(t => t.title);
  assert.ok(titles.includes('Meetup return fills rooms again'));
  assert.ok(titles.includes('Venue strike hits Shoreditch'));
  assert.equal(titles.length, 2);
  assert.equal(new Set(focusSeen).size, 3, 'each search had its own focus');
  assert.deepEqual(mergeTopics([]), []);
});

const page = (status, body = '', type = 'text/html') => async () => ({ status, headers: { get: () => type }, text: async () => body, body: { cancel: async () => {} } });

test('source links are opened: dead links dropped, figures must appear on the page, blocked pages flagged not trusted', async () => {
  const fact = { ...FACT, text: 'Community meetup attendance fell by 18.9% in volume to 7.1 thousand people.' };
  assert.equal(await checkFact(fact, page(200, 'volumes fell 18.9 percent to 7.1 million hl')), 'ok');
  assert.equal(await checkFact(fact, page(200, 'an unrelated page about something else 3 4')), 'unverified');
  assert.equal(await checkFact(fact, page(404)), 'dead');
  assert.equal(await checkFact(fact, page(403)), 'unverified');
  assert.equal(await checkFact({ ...FACT, text: 'Organisers are returning to in-person events.' }, page(200, 'whatever')), 'ok', 'no figures to check');
  assert.equal(await checkFact(fact, async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }), 'dead');
  assert.equal(await checkFact(fact, async () => { throw new Error('timeout'); }), 'unverified');
  const topic = { id: 't1', title: 'T', facts: [fact, { ...fact, url: 'https://fake.example/x' }] };
  let n = 0;
  const out = await verifySources([topic, { id: 't2', title: 'Only dead', facts: [fact] }], async () => (n++ % 3 === 1 ? (await page(404)()) : (await page(200, '18.9 7.1')())));
  assert.equal(out.length >= 1, true);
  assert.ok(out.every(t => t.facts.every(f => f.linkStatus !== 'dead')));
});

test('dates written with unicode hyphens are understood', () => {
  const out = cleanTopics({ topics: [{ title: 'Industry exports slide', category: 'trends', whyItMatters: 'x', affectsTargetAudience: true, sensitive: false, bestDay: 'fri',
    facts: [{ ...FACT, url: 'https://industrynews.com/en/story-1', date: '2026\u201110\u201119', text: 'Industry exports fell 18.9% in volume.' }] }] }, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].facts[0].date, '2026-10-19');
  const future = cleanTopics({ topics: [{ title: 'Guide', category: 'best-practices', whyItMatters: 'x', affectsTargetAudience: true, sensitive: false, bestDay: 'wed',
    facts: [{ ...FACT, url: 'https://industryguide.com/guide-1', date: '2026-11-28', text: 'Industry best practice guidance.' }] }] }, { now: NOW });
  assert.equal(future.length, 0, 'future dates are rejected, even for evergreen items');
});

function chatMock(turn, checks = [[]]) {
  const calls = [];
  let c = 0;
  return { calls, responses: { create: async (request) => {
    calls.push(request);
    if (request.text.format.name === 'fact_check') return { output_text: JSON.stringify({ unsupported: checks[Math.min(c++, checks.length - 1)] }) };
    return { model: 'm', output_text: JSON.stringify(turn) };
  } } };
}
const DRAFT = { post: 'Wishing everyone a happy Halloween.\n\nWhether you are at a meetup or in the office, stay safe tonight and enjoy the evening. From all of us here.', headline: 'Happy Halloween', tagline: 'From all of us', hashtags: ['Halloween'],
  visual: 'A co-working space at dusk with pumpkins', mustShow: ['A laptop', 'Pumpkins'], mustNotShow: ['Text or logos'], researchImage: false, toCheck: [] };

test('assistant prompt: facts only from the profile and the user, asks once for announcements, shows the occasion', () => {
  const text = chatInstructions('2026-10-20');
  assert.match(text, /Today is 2026-10-20/);
  assert.match(text, /only facts.*you may state/i);
  assert.match(text, /ask ONE short question/);
  assert.match(text, /no text.*letters.*numbers.*logos/i);
});

test('chat input is validated: must end with a user message, bounded, and drafts are trimmed', () => {
  assert.equal(validateChat({}), null);
  assert.equal(validateChat({ messages: [] }), null);
  assert.equal(validateChat({ messages: [{ role: 'assistant', content: 'hi' }] }), null);
  assert.equal(validateChat({ messages: [{ role: 'user', content: '' }] }), null);
  assert.equal(validateChat({ messages: Array(30).fill({ role: 'user', content: 'x' }) }), null);
  const ok = validateChat({ messages: [{ role: 'user', content: 'Halloween post' }], draft: { post: 'p', headline: 'h', hashtags: ['a', 'b', 'c', 'd'], evil: 'x' } });
  assert.deepEqual(ok.draft.hashtags, ['a', 'b', 'c']);
  assert.equal('evil' in ok.draft, false);
});

test('a draftable request returns a checked draft with an image checklist', async () => {
  const client = chatMock({ reply: 'Here is a Halloween post.', hasDraft: true, draft: DRAFT });
  const out = await chatTurn(client, { model: 'm', today: '2026-10-20', messages: [{ role: 'user', content: 'Halloween greeting please' }] });
  assert.equal(out.status, 200);
  assert.equal(out.body.draft.verified, true);
  assert.deepEqual(out.body.draft.mustShow, ['A laptop', 'Pumpkins']);
  assert.deepEqual(out.body.draft.lint, []);
  const check = client.calls.find(c => c.text.format.name === 'fact_check');
  assert.match(check.instructions, /Greetings, thanks, good wishes/);
  const facts = JSON.parse(check.input).facts.map(f => f.source);
  assert.ok(facts.some(s => /profile$/i.test(s)) && facts.includes('the user'));
});

test('a question turn returns no draft and makes no fact-check call', async () => {
  const client = chatMock({ reply: 'Where is the new meetup?', hasDraft: false, draft: { ...DRAFT, post: '' } });
  const out = await chatTurn(client, { model: 'm', today: '2026-10-20', messages: [{ role: 'user', content: 'post about our new meetup' }] });
  assert.equal(out.body.draft, null);
  assert.equal(out.body.reply, 'Where is the new meetup?');
  assert.equal(client.calls.length, 1);
});

test('claims beyond the profile and the user are flagged to check, not hidden', async () => {
  const claim = 'This investment reflects our commitment to faster turnarounds.';
  const client = chatMock({ reply: 'Done.', hasDraft: true, draft: { ...DRAFT, post: `We have a new meetup.\n\n${claim}` } }, [[{ sentence: claim, reason: 'Not supplied' }]]);
  const out = await chatTurn(client, { model: 'm', today: '2026-10-20', messages: [{ role: 'user', content: 'we have a new meetup' }] });
  assert.equal(out.body.draft.verified, false);
  assert.ok(out.body.draft.toCheck.some(c => c.startsWith(claim) && /Not supplied/.test(c)));
});

test('the chat route works end to end and rejects bad input', async () => {
  const client = chatMock({ reply: 'Here you go.', hasDraft: true, draft: DRAFT });
  const app = createApp({ client, model: 'test-model' });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/studio/chat`;
    const send = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await send({ messages: [{ role: 'user', content: 'Halloween' }] });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).draft.headline, 'Happy Halloween');
    assert.equal((await send({ messages: [] })).status, 400);
  } finally { app.close(); }
});

test('posts now aim for a proper LinkedIn length and use every fact', () => {
  const text = postInstructions('mon', false);
  assert.match(text, /120 to 200 words/);
  assert.match(verifyInstructions(), /closing question to the reader is allowed/);
  assert.match(text, /at most 15 words/);
  assert.match(text, /Never invent statistics/);
  assert.match(topicsInstructions('2026-10-20'), /2 to 5 DIFFERENT facts/);
  assert.ok(lintPost('Too short to be a real post at all.', []).some(w => /aim for 120 to 200/.test(w)));
  assert.equal(lintPost(GOOD, [FACT]).length, 0);
  assert.equal(lintPost(GOOD.replace(/Reuters/g, 'the report'), [{ ...FACT, source: 'Reuters' }]).some(w => /name its source/.test(w)), true);
  assert.equal(lintPost('According to Freightos reporting this week. ' + 'word '.repeat(100), [{ ...FACT, source: 'Freightos Baltic Index' }]).some(w => /name its source/.test(w)), false, 'a recognisable part of the source name counts');
});

test('a revision sends the current text and the reviewer instruction, fact-checks against the reviewer too, and keeps the rules', async () => {
  const client = mock({ drafts: [draft(GOOD)] });
  const out = await writePost(client, { model: 'm', topic, day: 'mon', prior: [], current: 'Old text that the reviewer edited.', instruction: 'Make it about what this means for first-time attendees' });
  assert.equal(out.status, 200);
  const first = client.calls[0];
  assert.match(first.instructions, /REVISING an existing post/);
  const input = JSON.parse(first.input);
  assert.equal(input.currentPost, 'Old text that the reviewer edited.');
  assert.equal(input.reviewerInstruction, 'Make it about what this means for first-time attendees');
  assert.ok(input.facts.some(f => f.source === 'the reviewer'));
  const check = JSON.parse(client.calls[1].input);
  assert.ok(check.facts.some(f => f.source === 'the reviewer'), 'the checker treats reviewer-stated facts as supplied');
});

test('the post route refuses a revision without current text and passes instruction through', async () => {
  const bad = await post('/api/studio/post', { day: 'mon', topic: { title: 'T', facts: [{ text: 'Organisers are returning to in-person events.', source: 'Reuters' }] }, instruction: 'shorter' });
  assert.equal(bad.status, 400);
  const ok = await post('/api/studio/post', { day: 'mon', topic: { title: 'T', facts: [{ text: 'Organisers are returning to in-person events.', source: 'Reuters' }] }, current: 'Some current text', instruction: 'shorter' });
  assert.equal(ok.status, 200);
});

test('the writer and the assistant brief a realistic photograph for the post', () => {
  const writer = postInstructions('mon', false);
  assert.match(writer, /headline of at most 7 plain words/);
  assert.match(writer, /visual description/);
  assert.match(chatInstructions('2026-10-20'), /realistic documentary-style photograph/);
});

test('assistant accepts attached documents, caps them, and guards confidential records', () => {
  const ok = validateChat({ messages: [{ role: 'user', content: 'Post from this' }], attachments: [{ name: 'guide.pdf', text: 'x'.repeat(40000) }, { name: 'tiny.txt', text: 'short' }, { name: 'b.docx', text: 'Heater pad guide. '.repeat(10) }, { name: 'c.pdf', text: 'y'.repeat(100) }] });
  assert.equal(ok.attachments.length, 2);
  assert.equal(ok.attachments[0].text.length, 30000);
  assert.deepEqual(validateChat({ messages: [{ role: 'user', content: 'hi' }] }).attachments, []);
  assert.match(chatInstructions('2026-10-20'), /attach documents/);
  assert.match(chatInstructions('2026-10-20'), /delivery order, stock or relocation form/);
});

test('a chat turn from an attachment fact-checks against the document text', async () => {
  const seen = [];
  const openai = { responses: { create: async req => {
    seen.push(req);
    const input = JSON.stringify(req.input);
    const out = seen.length === 1
      ? { reply: 'Drafted.', hasDraft: true, draft: { post: 'Lay the name badges on the sign-in table. '.repeat(5), headline: 'Name badges', tagline: '', hashtags: [], visual: 'a meetup', mustShow: ['a meetup'], mustNotShow: ['text'], researchImage: false, toCheck: [] } }
      : { unsupported: [] };
    return { output_text: JSON.stringify(out), output: [] };
  } } };
  const res = await chatTurn(openai, { model: 'm', today: '2026-10-20', messages: [{ role: 'user', content: 'Post from the guide' }], draft: null, attachments: [{ name: 'EXAMPLE DOCUMENT MEETUP.pdf', text: 'Spread the name badges over the full length of the table. '.repeat(8) }] }, undefined);
  assert.equal(res.status, 200);
  assert.match(JSON.stringify(seen[0].input), /EXAMPLE DOCUMENT MEETUP/);
  assert.match(JSON.stringify(seen[1].input), /EXAMPLE DOCUMENT MEETUP/);
});

test('an internal document stops the draft even if the model also returns one', async () => {
  const openai = { responses: { create: async () => ({ output_text: JSON.stringify({ reply: 'This looks internal, so I have not used it.', hasDraft: true, internalDocument: true, draft: { post: 'Should never appear. '.repeat(10), headline: 'x', tagline: '', hashtags: [], visual: 'x', mustShow: [], mustNotShow: [], researchImage: false, toCheck: [] } }), output: [] }) } };
  const res = await chatTurn(openai, { model: 'm', today: '2026-10-20', messages: [{ role: 'user', content: 'Post from this' }], draft: null, attachments: [{ name: 'Internal invoice creation.docx', text: 'Step 1: Find customer. '.repeat(20) }] }, undefined);
  assert.equal(res.status, 200);
  assert.equal(res.body.draft, null);
  assert.match(res.body.reply, /internal or commercial/);
});