
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const model = runInNewContext(`${readFileSync(new URL('./post-library.js', import.meta.url), 'utf8')}\nPostLibrary;`, { crypto: { randomUUID } });
const form = { source: 'Technical source material.', angle: 'problem', vertical: 'developers', voice: 'founder', count: 5, eventContext: '' };
const clone = value => JSON.parse(JSON.stringify(value));
const batch = (library, kind = 'week') => model.appendGroup(library, { kind, sourceType: kind === 'week' ? 'Demo' : 'AI', brief: form,
  posts: kind === 'week' ? [{ day: 'Monday', body: 'Original first paragraph.\n\nOriginal second paragraph.', tags: '#technical' }, { day: 'Tuesday', body: 'Second post.' }] : [{ body: 'Original AI post.' }] });

test('successive weekly and AI generations add groups without overwriting posts', () => {
  let library = batch(model.empty(form));
  const firstIds = library.posts.map(post => post.id);
  library = batch(library, 'ai');
  library = batch(library);
  assert.equal(library.groups.length, 3);
  assert.equal(library.posts.length, 5);
  assert.equal(new Set(library.posts.map(post => post.id)).size, 5);
  firstIds.forEach(id => assert.ok(library.posts.some(post => post.id === id)));
  assert.ok(model.validate(library));
});

test('AI and demo variations are separate records linked to original and immediate parent', () => {
  let library = batch(model.empty(form), 'ai');
  const original = library.posts[0];
  library = model.appendVariation(library, original.id, 'First variation.');
  const variation = library.posts[1];
  library = model.appendVariation(library, variation.id, 'Second variation.');
  assert.equal(library.posts[0].body, 'Original AI post.');
  assert.equal(library.posts[2].originalId, original.id);
  assert.equal(library.posts[2].variationOf, variation.id);
  assert.ok(model.validate(library));
});

test('weekly source contexts remain independent on each original and its variations after restoration', () => {
  const briefs = ['Monday source.', 'Wednesday source.', 'Friday source.'];
  let library = model.appendGroup(model.empty(form), { kind: 'week', sourceType: 'AI',
    brief: { ...form, count: 3, weeklyBriefs: ['Monday', 'Wednesday', 'Friday'].map((day, index) => ({ day, source: briefs[index], angle: 'problem' })) },
    posts: briefs.map((sourceContext, index) => ({ day: ['Monday', 'Wednesday', 'Friday'][index], body: 'Post ' + index, sourceContext })) });
  const fridayId = library.posts[2].id;
  library = model.appendVariation(library, fridayId, 'Friday variation.');
  const restored = model.parse(model.serialize(library));
  assert.deepEqual(Array.from(restored.posts, post => post.sourceContext), [...briefs, briefs[2]]);
  assert.equal(restored.posts[3].variationOf, fridayId);
  assert.equal(restored.groups[0].brief.weeklyBriefs[1].source, 'Wednesday source.');
});

test('edits retain generated content, statuses and intended dates survive round trips', () => {
  let library = batch(model.empty(form));
  library = model.updatePost(library, library.posts[0].id, { body: 'Edited technical draft.', status: 'Scheduled', publicationAt: '2020-01-01T09:30' });
  library = model.updatePost(library, library.posts[1].id, { status: 'Published' });
  const restored = model.parse(model.serialize(library));
  assert.equal(restored.posts[0].generatedBody, 'Original first paragraph.\n\nOriginal second paragraph.');
  assert.equal(restored.posts[0].body, 'Edited technical draft.');
  assert.equal(restored.posts[0].status, 'Scheduled');
  assert.equal(restored.posts[0].publicationAt, '2020-01-01T09:30');
  assert.equal(restored.posts[1].status, 'Published');
});

test('creation view, selected post, form edits and review expansion persist', () => {
  const library = batch(model.empty(form));
  library.session.selectedId = library.posts[1].id;
  library.session.view = 'setup';
  library.session.form.source = 'New source under preparation.';
  library.session.briefOpen = true;
  const restored = model.parse(model.serialize(library));
  assert.deepEqual(clone(restored.session), clone(library.session));
  assert.equal(restored.posts.length, 2);
});

test('migration preserves edited and approved v2 weekly posts and current creation view', () => {
  const old = { version: 2, mode: 'week', view: 'setup', generated: form, form: { ...form, source: 'New source.' },
    week: { live: false, selected: 1, data: { theme: 'Older week', posts: [{ body: 'Generated original.', tags: '#original' }, { body: 'Another original.' }] },
      working: [{ body: 'Saved edit.', tags: '#edited', status: 'Approved' }, { body: 'Another original.', tags: '', status: 'Draft' }] } };
  const { library } = model.migrate(JSON.stringify(old), null, form);
  assert.equal(library.posts[0].body, 'Saved edit.');
  assert.equal(library.posts[0].generatedBody, 'Generated original.');
  assert.equal(library.posts[0].status, 'Approved');
  assert.equal(library.posts[0].tags, '#edited');
  assert.equal(library.posts[0].generatedTags, '#original');
  assert.equal(library.session.selectedId, library.posts[1].id);
  assert.equal(library.session.view, 'setup');
  assert.equal(library.session.form.source, 'New source.');
  assert.ok(model.validate(library));
});

test('migration preserves v2 AI original, variations, selected version and source', () => {
  const old = { version: 2, mode: 'ai', generated: { ...form, count: 1 }, form: { angle: 'problem', count: 5 },
    ai: { drafts: ['Original.', 'Variation one.', 'Variation two.'], selected: 2 } };
  const { library } = model.migrate(JSON.stringify(old), null, form);
  assert.equal(library.posts.length, 3);
  assert.equal(library.posts[2].originalId, library.posts[0].id);
  assert.equal(library.posts[2].variationOf, null); // The old schema did not record the immediate parent.
  assert.equal(library.session.selectedId, library.posts[2].id);
  assert.equal(library.groups[0].brief.source, form.source);
});

test('migration preserves v1 saves and also imports a distinct older batch alongside v2', () => {
  const old = { version: 1, live: false, data: { posts: [{ body: 'Old original.' }] }, saved: { 0: { body: 'Old saved edit.', tags: '#old', status: 'Approved' } },
    brief: { source: 'Older source.', count: 2, angle: { value: 'mixed' }, vertical: { value: 'developers' }, voice: { value: 'founder' } } };
  let migrated = model.migrate(null, JSON.stringify(old), form).library;
  assert.equal(migrated.posts[0].body, 'Old saved edit.');
  assert.equal(migrated.posts[0].status, 'Approved');
  const recent = { version: 2, mode: 'ai', form, generated: form, ai: { drafts: ['Recent AI post.'], selected: 0 } };
  migrated = model.migrate(JSON.stringify(recent), JSON.stringify(old), form).library;
  assert.equal(migrated.groups.length, 2);
  assert.equal(migrated.posts.find(post => post.id === migrated.session.selectedId).body, 'Recent AI post.');
});

test('migration avoids exact duplicate backups but preserves a distinct older edit', () => {
  const original = { body: 'Shared generated text.', tags: '#technical' };
  const edit = { body: 'Current edit.', tags: '#current', status: 'Approved' };
  const recent = { version: 2, mode: 'week', form, generated: form,
    week: { live: false, selected: 0, data: { posts: [original] }, working: [edit] } };
  const older = { version: 1, live: false, data: { posts: [original] }, saved: { 0: edit },
    brief: { source: form.source, count: 5, angle: { value: form.angle }, vertical: { value: form.vertical }, voice: { value: form.voice } } };
  assert.equal(model.migrate(JSON.stringify(recent), JSON.stringify(older), form).library.groups.length, 1);
  older.saved[0] = { ...edit, body: 'Distinct older saved edit.' };
  const migrated = model.migrate(JSON.stringify(recent), JSON.stringify(older), form).library;
  assert.equal(migrated.groups.length, 2);
  assert.ok(migrated.posts.some(post => post.body === 'Distinct older saved edit.'));
});

test('failed storage writes preserve old backups and previously saved library', () => {
  const library = batch(model.empty(form));
  const values = new Map([[model.key, 'previous library'], ['sse-post-engine-session-v2', 'older session']]);
  const storage = { setItem() { throw new Error('QuotaExceededError'); } };
  assert.throws(() => model.save(storage, library), /QuotaExceededError/);
  assert.equal(values.get(model.key), 'previous library');
  assert.equal(values.get('sse-post-engine-session-v2'), 'older session');
  const written = new Map(values);
  model.save({ setItem(key, value) { written.set(key, value); } }, library);
  assert.equal(written.get('sse-post-engine-session-v2'), 'older session');
  assert.equal(model.parse(written.get(model.key)).posts.length, 2);
});

test('corrupted, unsupported and invalid relationship data are rejected without erasing anything', () => {
  assert.throws(() => model.parse('{broken'));
  assert.throws(() => model.parse('{"version":999}'));
  const invalid = batch(model.empty(form));
  invalid.posts[0].variationOf = 'missing';
  assert.equal(model.validate(invalid), false);
  const migration = model.migrate('{broken', null, form);
  assert.equal(migration.library.posts.length, 0);
  assert.ok(migration.notices.length);
  assert.equal(model.validPublication('2026-02-30T10:00'), false);
});