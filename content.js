(() => {
  const APP_RE = /^https?:\/\/store\.steampowered\.com\/app\/(\d+)/;
  const BATCH_DELAY_MS = 300;
  const SNIPPET_LEN = 180;
  const NEARBY_LEVELS = 5;
  const SHOW_CLASS = 'sads-show-disclosure';

  const anchorsById = new Map();
  const requested = new Set();
  const checked = new Set();
  const flagged = new Map(); // appId -> disclosure text
  let pending = [];
  let timer = null;
  let smartPriority = true;
  let showDisclosure = false;
  let crossSiteDetection = true;
  let observer = null;
  let panel = null;
  let hoveredPill = null;

  chrome.storage.local.get(['enabled', 'showDisclosure', 'smartPriority', 'crossSiteDetection']).then((settings) => {
    if (settings.enabled === false) return;
    smartPriority = settings.smartPriority !== false;
    showDisclosure = !!settings.showDisclosure;
    crossSiteDetection = settings.crossSiteDetection !== false;
    document.documentElement.classList.toggle(SHOW_CLASS, showDisclosure);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.showDisclosure) {
        showDisclosure = !!changes.showDisclosure.newValue;
        document.documentElement.classList.toggle(SHOW_CLASS, showDisclosure);
      }
      if (changes.smartPriority) {
        smartPriority = changes.smartPriority.newValue !== false;
      }
      if (changes.crossSiteDetection) {
        crossSiteDetection = changes.crossSiteDetection.newValue !== false;
        syncScanner();
      }
      if (changes.showDisclosure || changes.smartPriority) {
        hidePanel();
        refreshPills();
      }
    });
    chrome.runtime.onMessage.addListener(onMessage);
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    window.addEventListener('scroll', hidePanel, { capture: true, passive: true });
    syncScanner();
  });

  function syncScanner() {
    const isStorePage = location.hostname === 'store.steampowered.com';
    if (!isStorePage && !crossSiteDetection) {
      observer?.disconnect();
      observer = null;
      for (const id of anchorsById.keys()) requested.delete(id);
      anchorsById.clear();
      pending = [];
      clearTimeout(timer);
      timer = null;
      for (const anchor of document.querySelectorAll('a[data-sads-seen]')) {
        delete anchor.dataset.sadsSeen;
        delete anchor.dataset.sadsAppId;
      }
      return;
    }
    scan(document.body);
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      const addedRoots = new Set();
      for (const mutation of mutations) {
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) forget(node);
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) addedRoots.add(node);
        }
      }
      for (const root of addedRoots) {
        let parent = root.parentElement;
        while (parent && !addedRoots.has(parent)) parent = parent.parentElement;
        if (!parent && root.isConnected) scan(root);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function scan(root) {
    const anchors = root.matches('a[href]') ? [root] : root.querySelectorAll('a[href*="/app/"]');
    for (const a of anchors) {
      if (a.dataset.sadsSeen) continue;
      a.dataset.sadsSeen = '1';
      // a.href is already resolved, so relative /app/ links on Steam match too.
      const m = APP_RE.exec(a.href);
      if (!m) continue;
      const id = m[1];
      if (flagged.has(id)) {
        flag(a, id, flagged.get(id));
        continue;
      }
      if (checked.has(id)) continue;
      a.dataset.sadsAppId = id;
      if (!anchorsById.has(id)) anchorsById.set(id, new Set());
      anchorsById.get(id).add(a);
      if (!requested.has(id)) {
        requested.add(id);
        pending.push(id);
      }
    }
    if (pending.length) {
      clearTimeout(timer);
      timer = setTimeout(sendPending, BATCH_DELAY_MS);
    }
  }

  function forget(root) {
    const anchors = root.matches('a[data-sads-app-id]')
      ? [root]
      : root.querySelectorAll('a[data-sads-app-id]');
    for (const anchor of anchors) {
      if (anchor.isConnected) continue;
      const id = anchor.dataset.sadsAppId;
      const appAnchors = anchorsById.get(id);
      appAnchors?.delete(anchor);
      if (appAnchors?.size === 0) anchorsById.delete(id);
    }
  }

  function sendPending() {
    const appIds = pending;
    pending = [];
    chrome.runtime.sendMessage({ type: 'check', appIds }).catch(() => {});
  }

  function onMessage(msg) {
    if (msg.type !== 'result') return;
    const appAnchors = anchorsById.get(msg.appId);
    anchorsById.delete(msg.appId);
    checked.add(msg.appId);
    if (!msg.ai) return;
    flagged.set(msg.appId, msg.disclosure || '');
    // Image links first so a card gets the overlay rather than an inline pill.
    const anchors = [...(appAnchors || [])].filter((anchor) => anchor.isConnected).sort(
      (x, y) => !!y.querySelector('img') - !!x.querySelector('img')
    );
    for (const a of anchors) flag(a, msg.appId, msg.disclosure || '');
  }

  function flag(a, id, disclosure) {
    if (a.dataset.sadsFlagged) return;
    a.dataset.sadsFlagged = '1';
    a.classList.add('sads-flag');
    if (hasNearbyPill(a, id)) return;

    const pill = document.createElement('span');
    pill.className = 'sads-pill';
    pill.dataset.sadsApp = id;
    pill.title = pillTitle(disclosure);

    const label = document.createElement('span');
    label.className = 'sads-label';
    label.textContent = 'AI';
    pill.appendChild(label);

    if (disclosure) {
      const snippet = document.createElement('span');
      snippet.className = 'sads-snippet';
      pill.appendChild(snippet);
      fillText(pill, disclosure);
    }

    const img = a.querySelector('img');
    if (a.matches('.search_result_row')) {
      // Steam search: a full-width strip between listings instead of covering the thumbnail.
      pill.classList.add('sads-pill--row');
      a.after(pill);
    } else if (img) {
      // Anchor the overlay to the image box; some anchors also wrap the title.
      let host = img.parentElement;
      if (host.tagName === 'PICTURE' && host !== a) host = host.parentElement;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      pill.classList.add('sads-pill--overlay');
      host.appendChild(pill);
    } else {
      a.after(pill);
    }
  }

  // Store cards often hold several links to the same app (image, title, hover card).
  function hasNearbyPill(a, id) {
    let el = a;
    for (let i = 0; i < NEARBY_LEVELS && el; i++) {
      el = el.parentElement;
      if (el && el.querySelector(`.sads-pill[data-sads-app="${id}"]`)) return true;
    }
    return false;
  }

  function fillText(pill, disclosure) {
    const snippet = pill.querySelector('.sads-snippet');
    if (snippet) snippet.textContent = truncate(sadsDisplayDisclosure(disclosure, smartPriority), SNIPPET_LEN);
  }

  // The hover panel replaces the native tooltip while disclosure text is shown.
  function pillTitle(disclosure) {
    if (showDisclosure && disclosure) return '';
    return disclosure || 'Steam page has an AI Generated Content Disclosure';
  }

  function refreshPills() {
    for (const pill of document.querySelectorAll('.sads-pill[data-sads-app]')) {
      const disclosure = flagged.get(pill.dataset.sadsApp) || '';
      pill.title = pillTitle(disclosure);
      fillText(pill, disclosure);
    }
  }

  function onPointerOver(e) {
    // Steam can remove a hovered card without firing pointerout.
    if (hoveredPill && !hoveredPill.contains(e.target)) hidePanel();
    const pill = e.target.closest?.('.sads-pill[data-sads-app]');
    if (!pill || pill === hoveredPill) return;
    const disclosure = flagged.get(pill.dataset.sadsApp);
    if (!showDisclosure || !disclosure) return;
    hoveredPill = pill;
    pill.classList.add('sads-pill--hovered');
    showPanel(pill, sadsDisplayDisclosure(disclosure, smartPriority, '\n'));
  }

  function onPointerOut(e) {
    if (hoveredPill && !hoveredPill.contains(e.relatedTarget)) hidePanel();
  }

  // A popover lives in the browser's top layer, so no page z-index or overflow can cover or clip it.
  function showPanel(pill, text) {
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'sads-panel';
      panel.popover = 'manual';
      document.documentElement.appendChild(panel);
    }
    panel.textContent = text;
    const rect = pill.getBoundingClientRect();
    panel.style.minWidth = `${Math.min(rect.width, 480)}px`;
    panel.style.left = '0px';
    panel.style.top = '0px';
    if (!panel.matches(':popover-open')) panel.showPopover();
    const { width, height } = panel.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.left, innerWidth - width - 4));
    const top = rect.top + height + 4 > innerHeight ? Math.max(4, rect.bottom - height) : rect.top;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function hidePanel() {
    hoveredPill?.classList.remove('sads-pill--hovered');
    hoveredPill = null;
    if (panel?.matches(':popover-open')) panel.hidePopover();
  }

  function truncate(text, max) {
    return text.length > max ? text.slice(0, max - 1).trimEnd() + '\u2026' : text;
  }
})();
