const SNIPPET_LEN = 160;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const toggle = document.getElementById('enabled');
const crossSiteToggle = document.getElementById('crossSiteDetection');
const showToggle = document.getElementById('showDisclosure');
const smartToggle = document.getElementById('smartPriority');
const status = document.getElementById('status');
const list = document.getElementById('list');
const count = document.getElementById('count');
const empty = document.getElementById('empty');

chrome.storage.local.get(['enabled', 'crossSiteDetection', 'showDisclosure', 'smartPriority']).then((settings) => {
  toggle.checked = settings.enabled !== false;
  crossSiteToggle.checked = settings.crossSiteDetection !== false;
  showToggle.checked = !!settings.showDisclosure;
  smartToggle.checked = settings.smartPriority !== false;
  renderList();
});

toggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: toggle.checked });
  status.textContent = 'Reload pages to apply.';
});

crossSiteToggle.addEventListener('change', () => {
  chrome.storage.local.set({ crossSiteDetection: crossSiteToggle.checked });
});

showToggle.addEventListener('change', () => {
  chrome.storage.local.set({ showDisclosure: showToggle.checked });
});

smartToggle.addEventListener('change', async () => {
  await chrome.storage.local.set({ smartPriority: smartToggle.checked });
  renderList();
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearCache' });
  status.textContent = 'Cache cleared.';
  renderList();
});

async function renderList() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const expiredKeys = Object.entries(all)
    .filter(([key, value]) => key.startsWith('app:') && Number.isFinite(value?.ts) && now - value.ts >= TTL_MS)
    .map(([key]) => key);
  if (expiredKeys.length) chrome.storage.local.remove(expiredKeys).catch(() => {});
  const apps = Object.entries(all)
    .filter(([key, v]) => key.startsWith('app:') && v.ai && now - v.ts < TTL_MS)
    .map(([key, v]) => ({ id: key.slice(4), ...v }))
    .sort((a, b) => b.ts - a.ts);

  list.replaceChildren(...apps.map(renderItem));
  count.textContent = apps.length;
  empty.hidden = apps.length > 0;
}

// Built with textContent only: titles and disclosures are untrusted page text.
function renderItem(app) {
  const li = document.createElement('li');

  const link = document.createElement('a');
  link.href = `https://store.steampowered.com/app/${app.id}/`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = app.title || `App ${app.id}`;

  const id = document.createElement('span');
  id.className = 'appid';
  id.textContent = `#${app.id}`;

  const snippet = document.createElement('div');
  snippet.className = 'snippet';
  snippet.textContent = app.disclosure
    ? truncate(sadsDisplayDisclosure(app.disclosure, smartToggle.checked), SNIPPET_LEN)
    : '(no disclosure text cached)';
  snippet.title = app.disclosure || '';

  li.append(link, id, snippet);
  return li;
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '\u2026' : text;
}
