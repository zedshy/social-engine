import { randomBytes } from 'node:crypto';

export const CAPTION_LIMIT = 2200;
export const HASHTAG_LIMIT = 30;
export const DEFAULT_GRAPH_VERSION = 'v26.0';
const GRAPH_HOST = 'https://graph.instagram.com';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
function hashtagMatches(text) {
  return [...String(text).matchAll(/#[^\s#]+/g)];
}

const LOCAL_IMAGE_HELP = 'This image is on this machine. Instagram can only download a public JPEG. Set PUBLIC_BASE_URL to an https address its servers can reach (a tunnel such as ngrok for a local demo), or paste a public JPEG URL.';
const PRIVATE_BASE_HELP = 'PUBLIC_BASE_URL points at a private address, so Instagram cannot download the image. Use a public https URL, or paste a public JPEG URL.';

export function prepareCaption(raw) {
  const warnings = [];
  let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const matches = hashtagMatches(text);
  if (matches.length > HASHTAG_LIMIT) {
    const extra = matches.length - HASHTAG_LIMIT;
    const drop = matches.slice(HASHTAG_LIMIT);
    for (let i = drop.length - 1; i >= 0; i--) {
      const match = drop[i];
      text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    }
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    warnings.push(`Instagram allows ${HASHTAG_LIMIT} hashtags. Removed ${extra} extra hashtag${extra === 1 ? '' : 's'}.`);
  }
  const chars = [...text];
  if (chars.length > CAPTION_LIMIT) {
    const over = chars.length - CAPTION_LIMIT;
    text = chars.slice(0, CAPTION_LIMIT).join('').trimEnd();
    warnings.push(`Instagram allows 2,200 characters. The caption was shortened by ${over}.`);
  }
  const hashtagCount = hashtagMatches(text).length;
  return { caption: text, warnings, hashtagCount, length: [...text].length, trimmed: warnings.length > 0 };
}

export function createImageStore({ ttlMs = 15 * 60 * 1000, maxItems = 30, now = () => Date.now() } = {}) {
  const items = new Map();
  function prune() {
    for (const [id, item] of items) {
      if (item.expires <= now()) items.delete(id);
    }
    while (items.size > maxItems) items.delete(items.keys().next().value);
  }
  return {
    put(bytes, type) {
      prune();
      const id = randomBytes(16).toString('hex');
      items.set(id, { bytes, type, expires: now() + ttlMs });
      return id;
    },
    get(id) {
      const item = items.get(id);
      if (!item) return null;
      if (item.expires <= now()) { items.delete(id); return null; }
      return item;
    }
  };
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some(part => part > 255)) return true;
    const [a, b] = n;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host.includes(':')) {
    const head = host.split(':').find(Boolean) || '';
    if (/^fe[89ab]/.test(head) || /^f[cd]/.test(head)) return true;
  }
  return false;
}

function normalizeBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, problem: LOCAL_IMAGE_HELP };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, problem: 'PUBLIC_BASE_URL is not a valid URL.' }; }
  if (url.protocol !== 'https:') return { ok: false, problem: 'PUBLIC_BASE_URL must be https so Instagram can download the image.' };
  if (url.username || url.password) return { ok: false, problem: 'PUBLIC_BASE_URL must not include a username or password.' };
  if (isPrivateHost(url.hostname)) return { ok: false, problem: PRIVATE_BASE_HELP };
  const prefix = url.pathname.replace(/\/+$/, '');
  return { ok: true, base: prefix ? `${url.origin}${prefix}` : url.origin };
}

function checkPublicImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, problem: 'Paste a public https JPEG URL.' };
  if (raw.length > 2000) return { ok: false, problem: 'The image URL is too long.' };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, problem: 'The image URL is not valid. Paste a public https JPEG URL.' }; }
  if (url.protocol !== 'https:') return { ok: false, problem: 'The image URL must be https so Instagram can download it.' };
  if (url.username || url.password) return { ok: false, problem: 'The image URL must not include a username or password.' };
  if (isPrivateHost(url.hostname)) return { ok: false, problem: 'That image URL is on a private network. Instagram cannot download it.' };
  if (/\.(png|gif|webp|svg|bmp|heic)($|\?)/i.test(url.pathname)) {
    return { ok: false, problem: 'Instagram only publishes JPEG images. This URL looks like another format.' };
  }
  url.hash = '';
  return { ok: true, url: url.toString() };
}

function decodeJpeg(dataUrl) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) return { ok: false, problem: 'Instagram only accepts a JPEG. The post image could not be read as JPEG.' };
  const bytes = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, problem: 'Instagram only accepts a JPEG. The post image could not be read as JPEG.' };
  }
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, problem: 'The image must be 4 MB or smaller.' };
  return { ok: true, bytes };
}

function mediaUrl(base, id) {
  return `${base}/api/instagram/media/${id}`;
}

function graphVersion(value) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: true, version: DEFAULT_GRAPH_VERSION };
  if (!/^v\d+\.\d+$/.test(raw)) return { ok: false, version: DEFAULT_GRAPH_VERSION };
  return { ok: true, version: raw };
}

function redact(text, token) {
  let out = String(text || '');
  if (token && token.length >= 8) out = out.split(token).join('[redacted]');
  return out.slice(0, 400);
}

function publicMessage(payload, token) {
  const message = payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : '') || 'Instagram could not publish this post.';
  return redact(message, token);
}

async function readPayload(res) {
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { error: { message: 'Instagram returned an unreadable response.' } }; }
}

function wait(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createInstagramPublisher(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const store = options.store || createImageStore({ now });
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 400;
  const statusAttempts = Number.isInteger(options.statusAttempts) && options.statusAttempts > 0 ? options.statusAttempts : 4;

  function setting(key, envName, fallback = '') {
    if (Object.hasOwn(options, key)) return options[key] == null ? '' : String(options[key]);
    const env = process.env[envName];
    return env == null || env === '' ? fallback : env;
  }

  function config() {
    return {
      accessToken: setting('accessToken', 'INSTAGRAM_ACCESS_TOKEN').trim(),
      userId: setting('userId', 'INSTAGRAM_USER_ID').trim(),
      graphVersion: setting('graphVersion', 'INSTAGRAM_GRAPH_VERSION', DEFAULT_GRAPH_VERSION).trim(),
      publicBaseUrl: setting('publicBaseUrl', 'PUBLIC_BASE_URL').trim()
    };
  }

  function account(cfg) {
    const version = graphVersion(cfg.graphVersion);
    const userIdOk = /^\d+$/.test(cfg.userId);
    const configured = Boolean(cfg.accessToken && cfg.userId);
    return { ...version, userIdOk, configured, dryRun: !configured, userId: userIdOk ? cfg.userId : '' };
  }

  function requestsFor(version, userId, imageUrl, caption, creationId) {
    const id = userId || '{ig-user-id}';
    const root = `${GRAPH_HOST}/${version}/${id}`;
    return [
      { method: 'POST', url: `${root}/media`, body: { image_url: imageUrl, caption } },
      { method: 'POST', url: `${root}/media_publish`, body: { creation_id: creationId || '<container id from the media response>' } }
    ];
  }

  function describeImage(body, cfg, persist) {
    const explicit = typeof body?.imageUrl === 'string' ? body.imageUrl.trim() : '';
    if (explicit) {
      const checked = checkPublicImageUrl(explicit);
      if (!checked.ok) return { imageUrl: null, imageProblem: checked.problem };
      return { imageUrl: checked.url, imageProblem: null };
    }
    const data = typeof body?.imageData === 'string' ? body.imageData : '';
    const local = Boolean(data) || body?.hasImage === true;
    if (!local) return { imageUrl: null, imageProblem: 'Instagram needs an image. Create one for this post, or paste a public JPEG URL.' };
    let bytes = null;
    if (data) {
      const decoded = decodeJpeg(data);
      if (!decoded.ok) return { imageUrl: null, imageProblem: decoded.problem };
      bytes = decoded.bytes;
    } else if (persist) {
      return { imageUrl: null, imageProblem: 'The post image did not arrive. Create the image again, or paste a public JPEG URL.' };
    }
    const base = normalizeBase(cfg.publicBaseUrl);
    if (!base.ok) return { imageUrl: null, imageProblem: base.problem };
    if (!persist) return { imageUrl: mediaUrl(base.base, '{id}'), imageProblem: null };
    const id = store.put(bytes, 'image/jpeg');
    return { imageUrl: mediaUrl(base.base, id), imageProblem: null, hostedId: id };
  }

  function plan(body, { persist }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { error: 'Send a JSON object with the caption.' } };
    }
    if (typeof body.caption !== 'string') return { status: 400, body: { error: 'Send the post caption.' } };
    if (body.caption.length > 20000) return { status: 400, body: { error: 'Caption is too long to publish.' } };
    if (body.imageUrl != null && typeof body.imageUrl !== 'string') return { status: 400, body: { error: 'Image URL must be text.' } };
    if (body.imageData != null && typeof body.imageData !== 'string') return { status: 400, body: { error: 'Image data must be a JPEG data URL.' } };
    if (body.hasImage != null && typeof body.hasImage !== 'boolean') return { status: 400, body: { error: 'hasImage must be true or false.' } };

    const cfg = config();
    const prepared = prepareCaption(body.caption);
    const who = account(cfg);
    const image = describeImage(body, cfg, persist);
    const warnings = prepared.warnings.slice();
    if (!who.ok) warnings.push('INSTAGRAM_GRAPH_VERSION must look like v26.0. The preview uses v26.0.');
    if (cfg.userId && !who.userIdOk) warnings.push('INSTAGRAM_USER_ID must be the numeric Instagram professional account id, not the @handle.');
    if (!prepared.caption) warnings.push('Add a caption before posting.');
    const captionProblem = prepared.caption ? null : 'Add a caption before posting.';
    const versionBlocked = cfg.graphVersion && !who.ok;
    const userBlocked = Boolean(cfg.userId) && !who.userIdOk;
    const canPublish = who.dryRun || (!image.imageProblem && !captionProblem && !versionBlocked && !userBlocked && who.userIdOk);
    const view = {
      dryRun: who.dryRun,
      published: false,
      configured: who.configured,
      caption: prepared.caption,
      warnings,
      length: prepared.length,
      hashtagCount: prepared.hashtagCount,
      imageUrl: image.imageUrl,
      imageProblem: image.imageProblem,
      canPublish,
      limits: { caption: CAPTION_LIMIT, hashtags: HASHTAG_LIMIT },
      requests: requestsFor(who.version, who.userId, image.imageUrl, prepared.caption)
    };
    return { status: 200, view, cfg, who, image, prepared, captionProblem, versionBlocked, userBlocked };
  }

  function blockingError(planned) {
    if (planned.versionBlocked) return 'INSTAGRAM_GRAPH_VERSION must look like v26.0.';
    if (planned.userBlocked || !planned.who.userIdOk) return 'INSTAGRAM_USER_ID must be the numeric Instagram professional account id, not the @handle.';
    if (planned.captionProblem) return planned.captionProblem;
    return planned.image.imageProblem || 'Instagram needs a public JPEG before it can publish.';
  }

  async function waitForContainer(version, containerId, token) {
    let last = 'IN_PROGRESS';
    const headers = { Authorization: `Bearer ${token}` };
    for (let attempt = 0; attempt < statusAttempts; attempt++) {
      const url = `${GRAPH_HOST}/${version}/${containerId}?fields=status_code`;
      let res;
      let payload;
      try {
        res = await fetchImpl(url, { method: 'GET', headers });
        payload = await readPayload(res);
      } catch {
        return { ok: false, error: 'Could not reach Instagram to check the image.' };
      }
      if (!res.ok) return { ok: false, error: publicMessage(payload, token) };
      last = payload.status_code || last;
      if (last === 'FINISHED') return { ok: true };
      if (last === 'ERROR' || last === 'EXPIRED') return { ok: false, error: `Instagram could not prepare the image (${last}).` };
      if (last === 'PUBLISHED') return { ok: false, error: 'Instagram says this image was already published.' };
      if (attempt < statusAttempts - 1) await wait(pollIntervalMs);
    }
    return { ok: false, error: `Instagram is still preparing the image (${last}). Try again in a moment.` };
  }

  async function publishLive(planned) {
    const token = planned.cfg.accessToken;
    const version = planned.who.version;
    const userId = planned.who.userId;
    const imageUrl = planned.image.imageUrl;
    const caption = planned.prepared.caption;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const mediaEndpoint = `${GRAPH_HOST}/${version}/${userId}/media`;
    let created;
    let createdBody;
    try {
      created = await fetchImpl(mediaEndpoint, { method: 'POST', headers, body: JSON.stringify({ image_url: imageUrl, caption }) });
      createdBody = await readPayload(created);
    } catch {
      return { status: 502, body: { error: 'Could not reach Instagram.', dryRun: false, published: false } };
    }
    const containerId = created.ok ? String(createdBody.id || '') : '';
    if (!created.ok || !/^\d+$/.test(containerId)) {
      return { status: 502, body: { error: publicMessage(createdBody, token), dryRun: false, published: false } };
    }
    const ready = await waitForContainer(version, containerId, token);
    if (!ready.ok) return { status: 502, body: { error: ready.error, dryRun: false, published: false, containerId } };
    const publishEndpoint = `${GRAPH_HOST}/${version}/${userId}/media_publish`;
    let published;
    let publishedBody;
    try {
      published = await fetchImpl(publishEndpoint, { method: 'POST', headers, body: JSON.stringify({ creation_id: containerId }) });
      publishedBody = await readPayload(published);
    } catch {
      return { status: 502, body: { error: 'Could not reach Instagram to publish the container.', dryRun: false, published: false, containerId } };
    }
    const mediaId = published.ok ? String(publishedBody.id || '') : '';
    if (!published.ok || !/^\d+$/.test(mediaId)) {
      return { status: 502, body: { error: publicMessage(publishedBody, token), dryRun: false, published: false, containerId } };
    }
    return {
      status: 200,
      body: {
        ...planned.view,
        dryRun: false,
        published: true,
        canPublish: false,
        containerId,
        mediaId,
        imageUrl,
        requests: requestsFor(version, userId, imageUrl, caption, containerId)
      }
    };
  }

  return {
    status() {
      const cfg = config();
      const who = account(cfg);
      const base = normalizeBase(cfg.publicBaseUrl);
      return {
        configured: who.configured,
        dryRun: who.dryRun,
        graphVersion: who.version,
        publicImageHosting: base.ok,
        limits: { caption: CAPTION_LIMIT, hashtags: HASHTAG_LIMIT }
      };
    },
    preview(body) {
      const planned = plan(body, { persist: false });
      if (planned.status !== 200) return planned;
      return { status: 200, body: planned.view };
    },
    async publish(body) {
      const planned = plan(body, { persist: false });
      if (planned.status !== 200) return planned;
      if (!planned.who.dryRun && !planned.view.canPublish) {
        return { status: 400, body: { error: blockingError(planned), dryRun: false, published: false, warnings: planned.view.warnings, imageProblem: planned.image.imageProblem } };
      }
      const hosted = describeImage(body, planned.cfg, true);
      const imageUrl = hosted.imageUrl;
      const imageProblem = hosted.imageProblem;
      const view = {
        ...planned.view,
        imageUrl,
        imageProblem,
        canPublish: planned.who.dryRun || !imageProblem,
        requests: requestsFor(planned.who.version, planned.who.userId, imageUrl, planned.prepared.caption)
      };
      if (planned.who.dryRun) return { status: 200, body: view };
      if (imageProblem) return { status: 400, body: { error: imageProblem, dryRun: false, published: false, warnings: view.warnings, imageProblem } };
      planned.view = view;
      planned.image = hosted;
      return publishLive(planned);
    },
    serve(res, path) {
      const id = /^\/api\/instagram\/media\/([a-f0-9]{32})$/.exec(path)?.[1];
      const item = id && store.get(id);
      if (!item) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': item.type,
        'Content-Length': item.bytes.length,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(item.bytes);
    }
  };
}
