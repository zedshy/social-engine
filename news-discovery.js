
import { SaxesParser } from 'saxes';

// Fixed publisher endpoints only. No article-page requests or AI calls.
export const NEWS_SOURCES = Object.freeze([
  { id: 'techcrunch', name: 'TechCrunch', website: 'https://techcrunch.com/', feed: 'https://techcrunch.com/feed/', note: 'Public RSS metadata only; publisher copyright applies.' },
  { id: 'theverge', name: 'The Verge', website: 'https://www.theverge.com/', feed: 'https://www.theverge.com/rss/index.xml', note: 'Homepage advertises this RSS feed.' },
  { id: 'hacker-news', name: 'Hacker News', website: 'https://news.ycombinator.com/', feed: 'https://news.ycombinator.com/rss', disabled: true, note: 'Disabled: publisher terms require written consent for automated collection.' },
  { id: 'sifted', name: 'Sifted', website: 'https://sifted.eu/', feed: 'https://sifted.eu/feed/', note: 'Official European startup feed; AI permission is not established.' },
  { id: 'arstechnica', name: 'Ars Technica', website: 'https://arstechnica.com/', feed: 'https://feeds.arstechnica.com/arstechnica/index', note: 'RSS links permitted. No article text or AI use assumed.' }
]);
const MAX_BYTES = 2 * 1024 * 1024;
const DAY = 86400000;
const MAX_AGE_DAYS = 90;
const CACHE_MS = 10 * 60000;

function plain(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function articleUrl(value, source) {
  try {
    const url = new URL(value, source.website);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.hostname.replace(/^www\./, '') !== new URL(source.website).hostname.replace(/^www\./, '')) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

// Collect only direct metadata children. content:encoded, descriptions and Atom
// content are intentionally ignored, even if a feed includes full articles.
export function parseFeed(xml, source) {
  if (Buffer.byteLength(xml) > MAX_BYTES) throw new Error('Feed exceeds size limit.');
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const items = [];
  let item = null, field = null, value = '', root = '';
  parser.on('doctype', () => { throw new Error('Feed DTDs are not supported.'); });
  parser.on('opentag', tag => {
    stack.push(tag.local);
    if (stack.length === 1) root = tag.local;
    if ((tag.local === 'item' || tag.local === 'entry') && !item) item = { depth: stack.length };
    else if (item && stack.length === item.depth + 1) {
      if (['title', 'link', 'pubDate', 'published', 'updated', 'date'].includes(tag.local)) {
        field = tag.local; value = '';
        if (field === 'link' && tag.attributes.href && (!tag.attributes.rel || tag.attributes.rel.value === 'alternate')) item.link = tag.attributes.href.value;
      }
    }
  });
  const append = text => { if (field) value = (value + text).slice(0, 4000); };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => {
    if (item && stack.length === item.depth + 1 && field) {
      if (field !== 'link' || !item.link) item[field] = value;
      field = null; value = '';
    }
    if (item && stack.length === item.depth) {
      if (items.length >= 500) throw new Error('Feed has too many entries.');
      items.push({ title: plain(item.title), url: item.link?.trim() ? articleUrl(item.link.trim(), source) : null,
        publishedAt: item.pubDate || item.published || item.date || item.updated || null });
      item = null;
    }
    stack.pop();
  });
  parser.write(xml).close();
  if (!['rss', 'feed', 'RDF'].includes(root)) throw new Error('Response is not an RSS or Atom feed.');
  return items;
}

export function relevance(title) {
  const terms = [
    ['hackathons', /\bhackathons?\b/i, 10],
    ['developer events', /\b(?:meetups?|conferences?|tech week)\b/i, 8],
    ['startups', /\b(?:startups?|founders?)\b/i, 6],
    ['developers', /\b(?:developers?|software|open source|programming)\b/i, 5],
    ['london tech', /\b(?:london tech|shoreditch|silicon roundabout)\b/i, 2]
  ];
  const matches = terms.filter(([, regex]) => regex.test(title));
  return { score: matches.reduce((sum, [, , weight]) => sum + weight, 0), matches: matches.map(([label]) => label) };
}

export function selectArticles(items, now = Date.now()) {
  const urls = new Set(), titles = new Set();
  return items.flatMap(item => {
    const date = Date.parse(item.publishedAt);
    if (!item.title || !item.url || !Number.isFinite(date) || date < now - MAX_AGE_DAYS * DAY || date > now + DAY) return [];
    return [{ ...item, publishedAt: new Date(date).toISOString(), ...relevance(item.title) }];
  }).sort((a, b) => b.score - a.score || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .filter(item => {
      const title = item.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (urls.has(item.url) || titles.has(title)) return false;
      urls.add(item.url); titles.add(title); return true;
    }).slice(0, 100);
}

async function fetchFeed(source, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.feed, { redirect: 'error', signal: controller.signal,
      headers: { 'User-Agent': 'Brand-News-Discovery/0.1 (local RSS reader)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Publisher returned HTTP ${response.status}.`); }
    if (!/\b(?:xml|rss|atom)\b/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); throw new Error('Publisher did not return XML.');
    }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('Feed exceeds size limit.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    return parseFeed(Buffer.concat(chunks).toString('utf8'), source);
  } finally { clearTimeout(timer); }
}

export function createNewsDiscovery({ fetchImpl = fetch, now = Date.now, timeoutMs = 10000 } = {}) {
  let cached, pending;
  return async function discover() {
    if (cached && now() - Date.parse(cached.checkedAt) < CACHE_MS) return { ...cached, cached: true };
    if (pending) return pending;
    pending = (async () => {
      const checkedAt = new Date(now()).toISOString();
      const results = await Promise.all(NEWS_SOURCES.map(async source => {
        const { disabled, ...info } = source;
        if (disabled) return { source: { ...info, status: 'restricted', received: 0, eligible: 0 }, items: [] };
        try {
          const entries = await fetchFeed(source, fetchImpl, timeoutMs);
          const items = selectArticles(entries.map(item => ({ ...item, sourceId: source.id, source: source.name })), now());
          return { source: { ...info, status: !entries.length ? 'empty' : !items.length ? 'no-recent-items' : 'ok', received: entries.length, eligible: items.length }, items };
        } catch (error) {
          return { source: { ...info, status: 'failed', received: 0, eligible: 0,
            error: error.name === 'AbortError' ? 'Feed request timed out.' : 'Feed unavailable or invalid; try again after the cache expires.' }, items: [] };
        }
      }));
      cached = { kind: 'live', checkedAt, nextCheckAt: new Date(Date.parse(checkedAt) + CACHE_MS).toISOString(), maxAgeDays: MAX_AGE_DAYS,
        articles: selectArticles(results.flatMap(result => result.items), now()), sources: results.map(result => result.source) };
      return { ...cached, cached: false };
    })();
    try { return await pending; } finally { pending = null; }
  };
}