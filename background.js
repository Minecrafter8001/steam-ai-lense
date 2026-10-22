const HEADING = 'AI Generated Content Disclosure';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 2;
const GAP_MS = 400;
const MAX_BACKOFF_MS = 60000;

const queue = [];
const inFlight = new Map(); // appId -> Set of tabIds waiting for the result
let active = 0;
let nextSlot = 0;
let backoffMs = 0;

class RateLimited extends Error {}

// Entries cached before v0.2 have no title/disclosure; drop them so they get refetched.
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('app:') && all[k].ai && all[k].disclosure === undefined);
  await chrome.storage.local.remove(stale);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'check' && sender.tab && Array.isArray(msg.appIds)) {
    handleCheck(msg.appIds, sender.tab.id);
    return false;
  }
  if (msg.type === 'clearCache') {
    clearCache().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function handleCheck(appIds, tabId) {
  const keys = appIds.map(cacheKey);
  const cached = await chrome.storage.local.get(keys);
  const now = Date.now();
  const expiredKeys = [];
  const uncachedIds = [];
  for (const id of appIds) {
    const entry = cached[cacheKey(id)];
    if (entry && now - entry.ts < TTL_MS) {
      notify([tabId], id, entry);
    } else {
      uncachedIds.push(id);
      if (entry) expiredKeys.push(cacheKey(id));
    }
  }
  if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
  for (const id of uncachedIds) enqueue(id, tabId);
}

function enqueue(id, tabId) {
  if (inFlight.has(id)) {
    inFlight.get(id).add(tabId);
    return;
  }
  inFlight.set(id, new Set([tabId]));
  queue.push(id);
  pump();
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const now = Date.now();
    const delay = Math.max(0, nextSlot - now);
    nextSlot = Math.max(now, nextSlot) + GAP_MS;
    active++;
    setTimeout(() => run(id), delay);
  }
}

async function run(id) {
  try {
    const result = await checkApp(id);
    backoffMs = 0;
    if (result) {
      const entry = { ...result, ts: Date.now() };
      await chrome.storage.local.set({ [cacheKey(id)]: entry });
      notify([...inFlight.get(id)], id, entry);
    }
    inFlight.delete(id);
  } catch (err) {
    if (err instanceof RateLimited) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 2000, MAX_BACKOFF_MS);
      nextSlot = Date.now() + backoffMs;
      queue.push(id);
    } else {
      inFlight.delete(id);
    }
  } finally {
    active--;
    pump();
  }
}

// Returns { ai, title, disclosure }, or null when the page could not be read as that app.
async function checkApp(id) {
  const res = await fetch(`https://store.steampowered.com/app/${id}/?l=english`, {
    credentials: 'include'
  });
  if (res.status === 429) throw new RateLimited();
  if (!res.ok) return null;
  const path = new URL(res.url).pathname;
  if (path !== `/app/${id}` && !path.startsWith(`/app/${id}/`)) return null;
  const html = await res.text();
  const idx = html.indexOf(HEADING);
  if (idx === -1) return { ai: false };
  return { ai: true, title: extractTitle(html), disclosure: extractDisclosure(html, idx) };
}

function extractTitle(html) {
  const m = /id="appHubAppName"[^>]*>([^<]*)</.exec(html) || /<title>([^<]*?)(?: on Steam)?<\/title>/.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

function extractDisclosure(html, idx) {
  const end = html.indexOf('</div>', idx);
  const section = html.slice(idx + HEADING.length, end === -1 ? idx + 3000 : end);
  // Steam wraps the developer's own text in <i>; fall back to the whole section.
  const italic = /<i>([\s\S]*?)<\/i>/.exec(section);
  // Source whitespace is formatting only; <br> marks real paragraph breaks.
  const text = (italic ? italic[1] : section)
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1000);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e.toLowerCase()] ?? match;
    const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
  });
}

function notify(tabIds, appId, entry) {
  const msg = { type: 'result', appId, ai: entry.ai, disclosure: entry.disclosure || '' };
  for (const tabId of tabIds) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('app:'));
  await chrome.storage.local.remove(keys);
}

function cacheKey(id) {
  return `app:${id}`;
}
