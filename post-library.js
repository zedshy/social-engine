
/* Local Post Library data model. No credentials, images or remote publishing. */
var PostLibrary = (function () {
  'use strict';
  var key = 'sse-post-library-v1';
  var statuses = ['Draft', 'Approved', 'Scheduled', 'Published'];
  function id() { return crypto.randomUUID(); }
  function preview(body) { return String(body).trim().split(/\r?\n/)[0].slice(0, 110) || 'Untitled draft'; }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function empty(form) {
    return { version: 1, groups: [], posts: [], session: { selectedId: null, filter: 'All Posts', view: 'empty', form: copy(form), briefOpen: false } };
  }
  function newPost(group, item) {
    var body = String(item.body == null ? item.hook || '' : item.body);
    return { id: id(), groupId: group.id, body: body, generatedBody: String(item.generatedBody == null ? body : item.generatedBody),
      tags: String(item.tags || ''), generatedTags: String(item.generatedTags == null ? item.tags || '' : item.generatedTags),
      title: preview(body), createdAt: group.createdAt, sourceType: group.sourceType,
      status: statuses.includes(item.status) ? item.status : 'Draft', publicationAt: item.publicationAt || '',
      sourceContext: String(item.sourceContext == null ? group.brief.source || '' : item.sourceContext),
      label: item.label || item.day || 'Original', angle: item.angle || '', why: item.why || '', measure: item.measure || '',
      originalId: null, variationOf: null };
  }
  function appendGroup(library, options) {
    var next = copy(library);
    var group = { id: id(), kind: options.kind, sourceType: options.sourceType, createdAt: new Date().toISOString(),
      title: options.title || options.brief.source.split(/\r?\n/)[0] || 'LinkedIn draft',
      brief: copy(options.brief), imported: !!options.imported };
    var posts = options.posts.map(function (item) { return newPost(group, item); });
    if (!posts.length) throw new Error('No posts were generated.');
    if (group.kind === 'ai') posts.forEach(function (post, index) {
      post.label = index ? 'Variation ' + index : 'Original';
      if (index) { post.originalId = posts[0].id; post.variationOf = options.imported ? null : posts[index - 1].id; }
    });
    next.groups.push(group);
    next.posts.push.apply(next.posts, posts);
    next.session = { selectedId: posts[0].id, filter: 'All Posts', view: 'drafted', form: copy(group.brief), briefOpen: false };
    return next;
  }
  function appendVariation(library, parentId, body, tags, sourceType) {
    var next = copy(library);
    var parent = next.posts.find(function (post) { return post.id === parentId; });
    if (!parent) throw new Error('Select a saved post before creating a variation.');
    var group = next.groups.find(function (item) { return item.id === parent.groupId; });
    var post = newPost(group, { body: body, tags: tags == null ? parent.tags : tags, angle: parent.angle,
      sourceContext: parent.sourceContext == null ? group.brief.source : parent.sourceContext });
    post.createdAt = new Date().toISOString();
    post.sourceType = sourceType || parent.sourceType;
    post.originalId = parent.originalId || parent.id;
    post.variationOf = parent.id;
    post.label = 'Variation ' + (next.posts.filter(function (item) { return item.originalId === post.originalId; }).length + 1);
    next.posts.push(post);
    next.session.selectedId = post.id;
    next.session.filter = 'All Posts';
    next.session.view = 'drafted';
    next.session.briefOpen = false;
    return next;
  }
  function updatePost(library, postId, changes) {
    var next = copy(library);
    var post = next.posts.find(function (item) { return item.id === postId; });
    if (!post) throw new Error('Saved post could not be found.');
    ['body', 'tags', 'status', 'publicationAt'].forEach(function (name) {
      if (Object.prototype.hasOwnProperty.call(changes, name)) post[name] = changes[name];
    });
    post.title = preview(post.body);
    return next;
  }
  function validBrief(brief) {
    return brief && typeof brief.source === 'string' && brief.source.length <= 8000 &&
      ['angle', 'vertical', 'voice'].every(function (field) { return typeof brief[field] === 'string' && brief[field].length <= 100; }) &&
      (brief.eventContext == null || typeof brief.eventContext === 'string' && brief.eventContext.length <= 200) &&
      (brief.generationMode == null || ['single', 'week'].includes(brief.generationMode)) &&
      Number.isInteger(Number(brief.count)) && Number(brief.count) >= 1 && Number(brief.count) <= 30 &&
      (brief.weeklyBriefs == null || Array.isArray(brief.weeklyBriefs) && brief.weeklyBriefs.length === 3 &&
        ['Monday', 'Wednesday', 'Friday'].every(function (day, index) {
          var item = brief.weeklyBriefs[index];
          return item && item.day === day && typeof item.source === 'string' && item.source.length <= 8000 &&
            typeof item.angle === 'string' && item.angle.length <= 100;
        }));
  }
  function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
  function validPublication(value) {
    if (value === '') return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return false;
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return false;
    var parts = value.split(/[-T:]/).map(Number);
    return date.getFullYear() === parts[0] && date.getMonth() + 1 === parts[1] && date.getDate() === parts[2] &&
      date.getHours() === parts[3] && date.getMinutes() === parts[4];
  }
  function validate(library) {
    if (!library || library.version !== 1 || !Array.isArray(library.groups) || !Array.isArray(library.posts) || !library.session) return false;
    var groups = new Map(), posts = new Map();
    if (!library.groups.every(function (group) {
      if (!group || typeof group.id !== 'string' || groups.has(group.id) || !['week', 'ai'].includes(group.kind) ||
          !['Demo', 'AI'].includes(group.sourceType) || !validDate(group.createdAt) || typeof group.title !== 'string' ||
          group.title.length > 5000 || !validBrief(group.brief)) return false;
      groups.set(group.id, group); return true;
    })) return false;
    if (!library.posts.every(function (post) {
      if (!post || typeof post.id !== 'string' || posts.has(post.id) || !groups.has(post.groupId) ||
          !statuses.includes(post.status) || !validPublication(post.publicationAt) || !validDate(post.createdAt) ||
          !['Demo', 'AI'].includes(post.sourceType) ||
          (post.sourceContext != null && (typeof post.sourceContext !== 'string' || post.sourceContext.length > 8000)) ||
          (post.generatedTags != null && (typeof post.generatedTags !== 'string' || post.generatedTags.length > 1000)) ||
          !['body', 'generatedBody', 'tags', 'title', 'label', 'angle', 'why', 'measure'].every(function (field) {
            return typeof post[field] === 'string' && post[field].length <= (field === 'tags' ? 1000 : 5000);
          })) return false;
      posts.set(post.id, post); return true;
    })) return false;
    if (!library.posts.every(function (post) {
      return ['originalId', 'variationOf'].every(function (field) {
        return post[field] === null || posts.has(post[field]) && posts.get(post[field]).groupId === post.groupId && post[field] !== post.id;
      });
    }) || !library.groups.every(function (group) { return library.posts.some(function (post) { return post.groupId === group.id; }); })) return false;
    var session = library.session;
    return validBrief(session.form) && ['empty', 'setup', 'drafted'].includes(session.view) &&
      ['All Posts', 'Drafts', 'Approved', 'Scheduled', 'Published'].includes(session.filter) &&
      (session.selectedId === null || posts.has(session.selectedId)) && typeof session.briefOpen === 'boolean';
  }
  function serialize(library) {
    if (!validate(library)) throw new Error('Post Library data is not valid. Your previously saved library is unchanged.');
    var next = copy(library);
    var selected = next.posts.find(function (post) { return post.id === next.session.selectedId; });
    var group = selected && next.groups.find(function (item) { return item.id === selected.groupId; });
    if (group && group.brief.source === next.session.form.source) {
      delete next.session.form.source;
      next.session.formSourceGroupId = group.id;
    }
    return JSON.stringify(next);
  }
  function parse(raw) {
    var library = JSON.parse(raw);
    if (library && library.session && library.session.form && library.session.form.source == null) {
      var group = Array.isArray(library.groups) && library.groups.find(function (item) { return item.id === library.session.formSourceGroupId; });
      if (group) library.session.form.source = group.brief.source;
    }
    if (!validate(library)) throw new Error('Saved Post Library data could not be read. It has been left untouched.');
    return library;
  }
  function migrate(sessionRaw, draftsRaw, form) {
    var next = empty(form), notices = [], imported = false;
    function read(raw) { try { return raw ? JSON.parse(raw) : null; } catch (error) { notices.push('Some older draft data could not be read and has been left untouched.'); return null; } }
    var session = read(sessionRaw), drafts = read(draftsRaw);
    function importWeek(data, working, brief, selected) {
      if (!data || !Array.isArray(data.posts) || !data.posts.length || data.posts.length > 30 || !validBrief(brief) ||
          !data.posts.every(function (post) { return post && typeof post === 'object'; })) return false;
      var sourceType = data.live === true ? 'AI' : 'Demo';
      var items = data.posts.map(function (post, index) {
        var edit = working && working[index];
        return { day: post.day, angle: post.angle, body: edit && typeof edit.body === 'string' ? edit.body : post.body || post.hook || '',
          generatedBody: post.body || post.hook || '', generatedTags: post.tags || '',
          tags: edit && typeof edit.tags === 'string' ? edit.tags : post.tags || '',
          status: edit && edit.status, why: post.why, measure: post.measure };
      });
      var candidate = appendGroup(next, { kind: 'week', sourceType: sourceType, title: data.theme, brief: brief, posts: items, imported: true });
      if (!validate(candidate)) return false;
      var records = candidate.posts.slice(next.posts.length);
      if (records[selected]) candidate.session.selectedId = records[selected].id;
      next = candidate; return true;
    }
    function flatBrief(brief) {
      if (!brief) return copy(form);
      return { source: brief.source, count: brief.count, angle: brief.angle && brief.angle.value,
        vertical: brief.vertical && brief.vertical.value, voice: brief.voice && brief.voice.value, eventContext: brief.eventContext || '' };
    }
    if (session && session.version === 2 && ['empty', 'week', 'ai'].includes(session.mode)) {
      var generated = session.generated, merged = Object.assign({}, generated || {}, session.form || {});
      if (session.mode === 'week') imported = importWeek(Object.assign({}, session.week && session.week.data, { live: session.week && session.week.live }),
        session.week && session.week.working, generated, session.week && session.week.selected);
      else if (session.mode === 'ai' && validBrief(generated) && session.ai && Array.isArray(session.ai.drafts) &&
          session.ai.drafts.length && session.ai.drafts.length <= 20 && session.ai.drafts.every(function (body) { return typeof body === 'string' && body.length <= 1800; })) {
        next = appendGroup(next, { kind: 'ai', sourceType: 'AI', brief: generated, posts: session.ai.drafts.map(function (body) { return { body: body }; }), imported: true });
        if (next.posts[session.ai.selected]) next.session.selectedId = next.posts[session.ai.selected].id;
        imported = true;
      }
      if (validBrief(merged)) next.session.form = copy(merged);
      if (session.view === 'setup') next.session.view = 'setup';
    }
    if (drafts && drafts.version === 1) {
      var olderBrief = flatBrief(drafts.brief);
      var duplicate = imported && drafts.data && Array.isArray(drafts.data.posts) && next.groups.some(function (group) {
        var records = next.posts.filter(function (post) { return post.groupId === group.id && !post.variationOf; });
        return group.kind === 'week' && group.brief.source === olderBrief.source && records.length === drafts.data.posts.length &&
          records.every(function (post, index) {
            var original = drafts.data.posts[index], edit = drafts.saved && drafts.saved[index];
            return original && post.generatedBody === (original.body || original.hook || '') &&
              post.body === (edit && typeof edit.body === 'string' ? edit.body : original.body || original.hook || '') &&
              post.tags === (edit && typeof edit.tags === 'string' ? edit.tags : original.tags || '') &&
              post.status === (edit && statuses.includes(edit.status) ? edit.status : 'Draft');
          });
      });
      if (!duplicate) {
        var activeSession = imported ? copy(next.session) : null;
        var olderImported = importWeek(Object.assign({}, drafts.data, { live: drafts.live }), drafts.saved, olderBrief, drafts.selected);
        if (activeSession) next.session = activeSession;
        imported = imported || olderImported;
      }
    }
    if ((sessionRaw || draftsRaw) && !imported && (!session || session.mode !== 'empty')) notices.push('No readable older posts were found. Older storage has been left untouched.');
    return { library: next, migrated: imported, notices: notices };
  }
  function save(storage, library) { storage.setItem(key, serialize(library)); }
  return { key: key, statuses: statuses, empty: empty, appendGroup: appendGroup, appendVariation: appendVariation,
    updatePost: updatePost, preview: preview, validate: validate, validPublication: validPublication,
    serialize: serialize, parse: parse, migrate: migrate, save: save };
}());