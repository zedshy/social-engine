
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
function page({ fetch, saved, confirm = () => true, desktop = false } = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url: 'http://localhost:8080/', runScripts: 'dangerously',
    pretendToBeVisual: true, virtualConsole: console,
    beforeParse(window) {
      window.confirm = confirm;
      window.matchMedia = query => ({ matches: desktop && query === '(min-width: 1121px)', addEventListener() {} });
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = fetch || (() => { throw new Error('Unexpected API request'); });
      if (saved) window.localStorage.setItem('sse-post-library-v1', saved);
    }
  });
  const document = dom.window.document;
  const byId = id => document.getElementById(id);
  const library = () => JSON.parse(dom.window.localStorage.getItem('sse-post-library-v1'));
  return { dom, errors, byId, library, click: id => byId(id).click() };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('page contains its library before app initialization without an external script dependency', () => {
  const embedded = html.match(/<script id="post-library-model">\n([\s\S]*?)<\/script>/)[1];
  assert.equal(embedded, readFileSync(new URL('./post-library.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(html, /<script[^>]+src="post-library\.js"/);
  assert.ok(html.indexOf('id="post-library-model"') < html.indexOf('function loadPostLibrary'));
});

test('generation uses one primary action, reports missing weekday material, and has no normal Save Draft button', async t => {
  const p = page(); t.after(() => p.dom.window.close());
  assert.equal(p.byId('generateAi').textContent, 'Generate Posts');
  assert.equal(p.byId('generateAiWeek'), null);
  p.byId('aiGenerationMode').value = 'week';
  p.byId('aiGenerationMode').dispatchEvent(new p.dom.window.Event('change'));
  p.click('generateAi');
  assert.match(p.byId('aiStatus').textContent, /Missing source material for Wednesday, Friday/);
  assert.match(p.byId('weeklySourceMonday').value, /London Tech Week 2026/);
  assert.equal(p.byId('weeklySourceMonday').closest('details').open, true);
  p.byId('aiGenerationMode').value = 'single';
  p.byId('aiGenerationMode').dispatchEvent(new p.dom.window.Event('change'));
  p.byId('src').value = 'Source for one post.';
  p.click('generateAi'); await wait(20);
  assert.equal([...p.dom.window.document.querySelectorAll('button')].some(button => button.textContent === 'Save Draft'), false);
});

test('actual Draft the Week button loads, saves and displays a week; selection survives refresh', async t => {
  const p = page(); t.after(() => p.dom.window.close());
  assert.deepEqual(p.errors, []);
  p.click('createWeek'); p.click('run');
  assert.equal(p.byId('run').disabled, true);
  assert.match(p.byId('status').textContent, /preparing/);
  await wait(900);
  assert.equal(p.library().posts.length, 5);
  assert.equal(p.library().groups.length, 1);
  assert.equal(p.byId('engineBrief').hidden, true);
  assert.equal(p.byId('out').hidden, false);
  assert.ok(p.byId('selectedDraft'));
  assert.match(p.byId('selectedDraft').textContent, /demo content/i);
  const restored = page({ saved: p.dom.window.localStorage.getItem('sse-post-library-v1') });
  t.after(() => restored.dom.window.close());
  assert.equal(restored.library().session.selectedId, p.library().session.selectedId);
  assert.equal(restored.byId('engineBrief').hidden, true);
  assert.equal(restored.byId('selectedDraft').textContent, p.byId('selectedDraft').textContent);
  assert.deepEqual([...p.errors, ...restored.errors], []);
});

test('AI button sends a request, shows loading, saves success and retains original across variation', async t => {
  const requests = []; let complete;
  const p = page({ fetch: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return await new Promise(resolve => { complete = resolve; });
  } }); t.after(() => p.dom.window.close());
  p.click('createWeek'); p.click('generateAi');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/generate');
  assert.equal(requests[0].body.mode, 'draft');
  assert.equal(p.byId('generateAi').disabled, true);
  assert.match(p.byId('aiStatus').textContent, /generating/i);
  complete({ ok: true, json: async () => ({ draft: 'A grounded technical draft.' }) });
  await wait(20);
  assert.equal(p.library().posts.length, 1);
  assert.equal(p.byId('engineBrief').hidden, true);
  assert.match(p.byId('selectedAiDraft').textContent, /A grounded technical draft/);
  const variation = [...p.dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'Generate AI variation');
  variation.click();
  assert.equal(requests[1].body.mode, 'variation');
  complete({ ok: true, json: async () => ({ draft: 'A revised technical draft.' }) });
  await wait(20);
  assert.equal(p.library().posts.length, 2);
  assert.equal(p.library().posts[0].body, 'A grounded technical draft.');
  assert.match(p.byId('selectedAiDraft').textContent, /A revised technical draft/);
  const restored = page({ saved: p.dom.window.localStorage.getItem('sse-post-library-v1') });
  t.after(() => restored.dom.window.close());
  assert.equal(restored.library().session.selectedId, p.library().session.selectedId);
  assert.match(restored.byId('selectedAiDraft').textContent, /A revised technical draft/);
  assert.deepEqual([...p.errors, ...restored.errors], []);
});

test('weekly AI generation snapshots three independent briefs, restores per-post sources, and varies the selected post', async t => {
  const requests = []; const pending = [];
  const p = page({ fetch: (url, options) => new Promise(resolve => {
    requests.push({ url, body: JSON.parse(options.body) }); pending.push(resolve);
  }) }); t.after(() => p.dom.window.close());
  p.click('createWeek');
  p.byId('aiGenerationMode').value = 'week';
  p.byId('aiGenerationMode').dispatchEvent(new p.dom.window.Event('change'));
  const originals = [
    ['weeklySourceMonday', 'Monday facts: 12 tonnes and source A.', 'weeklyAngleMonday', 'problem'],
    ['weeklySourceWednesday', 'Wednesday facts: 8 hours and source B.', 'weeklyAngleWednesday', 'faq'],
    ['weeklySourceFriday', 'Friday facts: 4 ports and source C.', 'weeklyAngleFriday', 'cost']
  ];
  for (const [sourceId, source, angleId, angle] of originals) {
    p.byId(sourceId).value = source;
    p.byId(angleId).value = angle;
  }
  p.click('generateAi');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.source, originals[0][1]);
  assert.equal(requests[0].body.angle, 'problem');
  assert.equal(p.byId('generateAi').disabled, true);
  assert.equal(p.byId('weeklySourceWednesday').disabled, true);
  assert.match(p.byId('aiStatus').textContent, /Monday.*1 of 3/);

  p.byId('weeklySourceWednesday').value = 'Changed after generation started.';
  p.byId('weeklyAngleFriday').value = 'faq';
  pending.shift()({ ok: true, json: async () => ({ draft: 'First distinct post.' }) });
  await wait(10);
  assert.equal(requests[1].body.source, originals[1][1]);
  assert.equal(requests[1].body.angle, 'faq');
  assert.equal('priorDrafts' in requests[1].body, false);
  pending.shift()({ ok: true, json: async () => ({ draft: 'Second distinct post.' }) });
  await wait(10);
  assert.equal(requests[2].body.source, originals[2][1]);
  assert.equal(requests[2].body.angle, 'cost');
  assert.equal(p.byId('weeklySourceWednesday').disabled, true);
  pending.shift()({ ok: true, json: async () => ({ draft: 'Third distinct post.' }) });
  await wait(30);

  const saved = p.library();
  assert.equal(saved.groups.length, 1);
  assert.equal(saved.groups[0].kind, 'week');
  assert.equal(saved.groups[0].sourceType, 'AI');
  assert.deepEqual(saved.posts.map(post => post.body), ['First distinct post.', 'Second distinct post.', 'Third distinct post.']);
  assert.deepEqual(saved.posts.map(post => post.sourceContext), [originals[0][1], originals[1][1], originals[2][1]]);
  assert.deepEqual(saved.posts.map(post => post.angle), ['problem', 'faq', 'cost']);
  assert.ok(saved.posts.every(post => post.status === 'Draft' && post.originalId === null && post.variationOf === null));
  assert.match(p.byId('aiStatus').textContent, /Three AI drafts generated and saved/);
  assert.match(p.byId('selectedAiDraft').textContent, /have not been independently verified/);

  const firstStatus = p.dom.window.document.querySelector('[aria-label="Post status"]');
  firstStatus.value = 'Approved';
  firstStatus.dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(p.byId('selectedAiDraft').querySelector('.post-status-indicator').textContent, 'Local status: Approved');
  assert.equal(p.dom.window.document.querySelectorAll('.post-selector-status')[0].textContent, 'Approved');
  assert.equal(p.dom.window.document.querySelector('.draft-save-status').textContent, 'Status saved: Approved');
  p.dom.window.document.querySelectorAll('.post-selector')[1].click();
  const secondStatus = p.dom.window.document.querySelector('[aria-label="Post status"]');
  secondStatus.value = 'Approved';
  secondStatus.dispatchEvent(new p.dom.window.Event('change'));
  const secondEditor = p.dom.window.document.querySelector('[aria-label="Post text"]');
  secondEditor.textContent = 'Edited second post.';
  secondEditor.dispatchEvent(new p.dom.window.Event('input', { bubbles: true }));
  assert.equal(p.library().posts[0].status, 'Approved');
  assert.equal(p.library().posts[1].status, 'Draft');
  assert.equal(p.library().posts[1].body, 'Edited second post.');
  assert.equal(p.byId('selectedAiDraft').querySelector('.post-status-indicator').textContent, 'Local status: Draft');
  assert.equal(p.dom.window.document.querySelectorAll('.post-selector-status')[1].textContent, 'Draft');
  assert.match(p.dom.window.document.querySelector('.draft-save-status').textContent, /needs approval again/);

  p.dom.window.document.querySelectorAll('.post-selector')[2].click();
  const variation = [...p.dom.window.document.querySelectorAll('button')].find(button => button.textContent === 'Generate AI variation');
  variation.click();
  assert.equal(requests[3].body.mode, 'variation');
  assert.equal(requests[3].body.source, originals[2][1]);
  assert.equal(requests[3].body.original, 'Third distinct post.');
  pending.shift()({ ok: true, json: async () => ({ draft: 'A distinct variation of the third post.' }) });
  await wait(30);
  const afterVariation = p.library();
  assert.equal(afterVariation.posts.length, 4);
  const child = afterVariation.posts[3];
  assert.equal(child.variationOf, saved.posts[2].id);
  assert.equal(child.originalId, saved.posts[2].id);
  assert.equal(child.status, 'Draft');
  assert.equal(child.sourceContext, originals[2][1]);

  const restored = page({ saved: p.dom.window.localStorage.getItem('sse-post-library-v1') });
  t.after(() => restored.dom.window.close());
  assert.equal(restored.library().posts.length, 4);
  assert.equal(restored.library().posts[0].sourceContext, originals[0][1]);
  assert.equal(restored.library().posts[1].sourceContext, originals[1][1]);
  assert.equal(restored.library().posts[0].status, 'Approved');
  assert.equal(restored.library().posts[1].status, 'Draft');
  assert.equal(restored.byId('selectedAiDraft').getAttribute('aria-label'), child.label + ' draft');
  assert.deepEqual([...p.errors, ...restored.errors], []);
});

test('a status change is not reported saved when browser storage fails', async t => {
  const p = page({ fetch: async () => ({ ok: true, json: async () => ({ draft: 'A source-grounded draft.' }) }) });
  t.after(() => p.dom.window.close());
  p.click('createWeek'); p.click('generateAi'); await wait(30);
  p.dom.window.Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
  const status = p.dom.window.document.querySelector('[aria-label="Post status"]');
  status.value = 'Approved';
  status.dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(p.byId('selectedAiDraft').querySelector('.post-status-indicator').textContent, 'Local status: Approved');
  assert.match(p.dom.window.document.querySelector('.draft-save-status').textContent, /Not saved to browser storage/);
  assert.doesNotMatch(p.dom.window.document.querySelector('.draft-save-status').textContent, /Status saved/);
});

test('weekly AI failure and Stop never save a partial three-post batch', async t => {
  for (const stop of [false, true]) {
    const pending = [];
    const p = page({ fetch: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    t.after(() => p.dom.window.close());
    p.click('createWeek'); p.byId('aiGenerationMode').value = 'week';
    ['Monday', 'Wednesday', 'Friday'].forEach(day => { p.byId('weeklySource' + day).value = day + ' verified notes'; });
    p.click('generateAi');
    pending.shift().resolve({ ok: true, json: async () => ({ draft: 'One completed post.' }) });
    await wait(10);
    if (stop) p.click('stop');
    else pending.shift().resolve({ ok: false, json: async () => ({ error: 'Second request failed.' }) });
    if (stop) pending.shift().reject(new DOMException('Aborted', 'AbortError'));
    await wait(20);
    assert.equal(p.library().groups.length, 0);
    assert.equal(p.library().posts.length, 0);
    assert.match(p.byId('aiStatus').textContent, /No partial batch was saved/);
  }
});

test('weekly AI storage failure reports three generated posts as unsaved', async t => {
  let call = 0;
  const p = page({ fetch: async () => ({ ok: true, json: async () => ({ draft: 'Distinct post ' + (++call) }) }) });
  t.after(() => p.dom.window.close());
  p.click('createWeek');
  const originalSetItem = p.dom.window.Storage.prototype.setItem;
  p.dom.window.Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
  p.byId('aiGenerationMode').value = 'week';
  ['Monday', 'Wednesday', 'Friday'].forEach(day => { p.byId('weeklySource' + day).value = day + ' verified notes'; });
  p.click('generateAi');
  await wait(40);
  assert.match(p.byId('aiStatus').textContent, /could not save them/);
  assert.match(p.byId('libraryStorageStatus').textContent, /could not be saved/);
  assert.match(p.byId('selectedAiDraft').textContent, /Distinct post 1/); // The page retains the completed batch.
  const retry = p.dom.window.document.querySelector('.retry-save-button');
  assert.equal(retry.hidden, false);
  p.dom.window.Storage.prototype.setItem = originalSetItem;
  retry.click();
  assert.equal(retry.hidden, true);
  assert.match(p.dom.window.document.querySelector('.draft-save-status').textContent, /Saved on this device/);
});

test('AI errors retain posts; Reset Demo confirms before clearing and prevents restoration', async t => {
  const p = page({ fetch: async () => ({ ok: false, json: async () => ({ error: 'Test API unavailable.' }) }) });
  t.after(() => p.dom.window.close());
  p.click('createWeek'); p.click('run'); await wait(900);
  const status = p.dom.window.document.querySelector('[aria-label="Post status"]');
  status.value = 'Scheduled';
  status.dispatchEvent(new p.dom.window.Event('change'));
  const date = p.dom.window.document.querySelector('[aria-label="Intended publication date and time"]');
  date.value = '2026-11-02T10:15';
  date.dispatchEvent(new p.dom.window.Event('change'));
  [...p.dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'Create Variation · demo').click();
  const posts = p.library().posts;
  assert.equal(posts.length, 6);
  assert.equal(posts[0].status, 'Scheduled');
  assert.equal(posts[0].publicationAt, '2026-11-02T10:15');
  assert.ok(posts[5].originalId);
  p.click('sidebarCreateWeek'); p.click('generateAi'); await wait(20);
  assert.match(p.byId('aiStatus').textContent, /Test API unavailable/);
  assert.equal(p.byId('generateAi').disabled, false);
  assert.deepEqual(p.library().posts, posts);
  let confirmation;
  p.dom.window.confirm = message => { confirmation = message; return false; };
  p.click('resetDemo');
  assert.match(confirmation, /Permanently delete/);
  assert.deepEqual(p.library().posts, posts);
  p.dom.window.confirm = () => true;
  p.dom.window.localStorage.setItem('sse-post-engine-session-v2', 'legacy backup');
  p.dom.window.localStorage.setItem('sse-saved-drafts-v1', 'legacy backup');
  p.dom.window.localStorage.setItem('sse-content-studio-demo-v1', 'studio sentinel');
  p.click('resetDemo');
  assert.equal(p.byId('engineEmpty').hidden, false);
  assert.equal(p.byId('engineWorkspace').hidden, true);
  assert.deepEqual(p.library().posts, []);
  assert.equal(p.dom.window.localStorage.getItem('sse-post-engine-session-v2'), null);
  assert.equal(p.dom.window.localStorage.getItem('sse-saved-drafts-v1'), null);
  assert.equal(p.dom.window.localStorage.getItem('sse-content-studio-demo-v1'), 'studio sentinel');
  assert.equal(p.library().session.view, 'empty');
  assert.match(p.byId('resetDemoStatus').textContent, /All saved posts have been deleted/);
  const restored = page({ saved: p.dom.window.localStorage.getItem('sse-post-library-v1') });
  t.after(() => restored.dom.window.close());
  assert.equal(restored.byId('engineEmpty').hidden, false);
  assert.deepEqual(restored.library().posts, []);
  assert.deepEqual([...p.errors, ...restored.errors], []);
});

test('Confirmed Reset Demo cancels a pending AI request without applying its late result', async t => {
  let complete, signal;
  const p = page({ fetch: async (_url, options) => {
    signal = options.signal;
    return await new Promise(resolve => { complete = resolve; });
  } }); t.after(() => p.dom.window.close());
  p.click('createWeek'); p.click('generateAi'); p.click('resetDemo');
  assert.equal(signal.aborted, true);
  complete({ ok: true, json: async () => ({ draft: 'Late result must not be applied.' }) });
  await wait(20);
  assert.equal(p.library().posts.length, 0);
  assert.equal(p.byId('engineEmpty').hidden, false);
  assert.equal(p.byId('generateAi').disabled, false);
  assert.deepEqual(p.errors, []);
});


test('sidebar Create Week hides review without losing drafts and Back to drafts restores it', async t => {
  const p = page(); t.after(() => p.dom.window.close());
  p.click('sidebarCreateWeek'); p.click('run'); await wait(900);
  const savedPosts = p.library().posts;
  p.click('sidebarCreateWeek');
  assert.equal(p.byId('engineBrief').hidden, false);
  assert.equal(p.byId('engineWorkspace').hasAttribute('data-generated'), false);
  assert.equal(p.library().session.view, 'setup');
  assert.equal(p.byId('backToDrafts').hidden, false);
  assert.deepEqual(p.library().posts, savedPosts);
  const restored = page({ saved: p.dom.window.localStorage.getItem('sse-post-library-v1') });
  t.after(() => restored.dom.window.close());
  assert.equal(restored.byId('engineBrief').hidden, false);
  assert.equal(restored.library().session.view, 'setup');
  restored.click('backToDrafts');
  assert.equal(restored.byId('engineBrief').hidden, true);
  assert.ok(restored.byId('selectedDraft'));
  assert.deepEqual(restored.library().posts, savedPosts);
  assert.deepEqual([...p.errors, ...restored.errors], []);
});


test('compact selector shows every batch despite dormant filters and opens weekly navigation', async t => {
  const p = page(); t.after(() => p.dom.window.close());
  p.click('createWeek'); p.click('run'); await wait(900);
  p.click('sidebarCreateWeek'); p.click('run'); await wait(900);
  const saved = p.library(); saved.session.filter = 'Scheduled';
  const restored = page({ saved: JSON.stringify(saved) });
  t.after(() => restored.dom.window.close());
  assert.equal(restored.byId('libraryFilters').hidden, true);
  assert.equal(restored.byId('draft-sets-title').textContent, 'Created Content');
  const batches = restored.byId('libraryGroups').querySelectorAll('button');
  assert.equal(batches.length, 2);
  assert.equal(restored.byId('savedBatchCount').textContent, '2');
  assert.equal(restored.byId('savedContentShortcut').title, '2 saved content batches');
  assert.equal(batches[0].textContent, 'Week 2 — 5 posts');
  assert.equal(batches[1].textContent, 'Week 1 — 5 posts');
  batches[1].click();
  assert.equal(restored.library().posts.length, 10);
  assert.equal(restored.library().session.selectedId, saved.posts[0].id);
  assert.equal(restored.byId('libraryGroups').querySelector('[aria-current="true"]').textContent, 'Week 1 — 5 posts');
  assert.equal(restored.dom.window.document.querySelectorAll('.post-selector').length, 5);
  assert.deepEqual([...p.errors, ...restored.errors], []);
});


test('collapsed shortcuts count batches, switch views without resetting Studio, and open creation', async t => {
  const p = page({ desktop: true }); t.after(() => p.dom.window.close());
  p.click('createWeek'); p.click('run'); await wait(900);
  assert.equal(p.byId('savedBatchCount').textContent, '1');
  assert.equal(p.byId('savedContentShortcut').title, '1 saved content batch');
  [...p.dom.window.document.querySelectorAll('button')].find(b => b.textContent === 'Create Variation · demo').click();
  assert.equal(p.library().posts.length, 6);
  assert.equal(p.byId('savedBatchCount').textContent, '1');
  p.click('visualShortcut');
  assert.equal(p.byId('contentStudioView').hidden, false);
  assert.equal(p.byId('visualShortcut').getAttribute('aria-pressed'), 'true');
  assert.equal(p.byId('savedContentShortcut').getAttribute('aria-pressed'), 'false');
  const studio = p.byId('studioExample').textContent;
  p.click('savedContentShortcut');
  assert.equal(p.byId('weeklyPostsView').hidden, false);
  assert.equal(p.byId('sidebar').getAttribute('data-collapsed'), 'false');
  const toggle = p.dom.window.document.querySelector('.sidebar-toggle');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.title, 'Collapse sidebar');
  assert.equal(toggle.querySelector('svg'), null);
  toggle.click();
  assert.equal(toggle.title, 'Expand sidebar');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  p.click('visualShortcut');
  assert.equal(p.byId('studioExample').textContent, studio);
  p.click('sidebarCreateWeek');
  assert.equal(p.byId('weeklyPostsView').hidden, false);
  assert.equal(p.byId('engineBrief').hidden, false);
  assert.equal(p.byId('savedContentShortcut').getAttribute('aria-pressed'), 'true');
  assert.equal(p.library().posts.length, 6);
  assert.equal(p.byId('sidebarCreateWeek').title, 'Create Week');
  assert.deepEqual(p.errors, []);
});