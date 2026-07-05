// background.js — service worker. Routes the toolbar button and the
// toolbar-icon context menu (genre picks) to a YTM tab: prefers the tab
// you're on, then an existing YTM tab (audible first), then opens one.

const BUCKETS_KEY = 'ytra_buckets';
const PENDING_KEY = 'ytra_pending';

async function routeRoll(tab, genre) {
  const msg = { type: 'RANDOM_ALBUM', genre: genre || null };

  // Case 1: current tab is YTM with a live content script.
  if (tab?.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, msg);
      return;
    } catch (e) {
      // fall through
    }
  }

  // Case 2: reuse an existing YTM tab.
  const ytmTabs = await chrome.tabs.query({ url: 'https://music.youtube.com/*' });
  const target = ytmTabs.find((t) => t.audible) || ytmTabs[0];
  if (target) {
    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    try {
      await chrome.tabs.sendMessage(target.id, msg);
      return;
    } catch (e) {
      await chrome.storage.local.set({ [PENDING_KEY]: { ts: Date.now(), genre: genre || null } });
      await chrome.tabs.reload(target.id);
      return;
    }
  }

  // Case 3: no YTM tab anywhere.
  await chrome.storage.local.set({ [PENDING_KEY]: { ts: Date.now(), genre: genre || null } });
  await chrome.tabs.create({ url: 'https://music.youtube.com/' });
}

chrome.action.onClicked.addListener((tab) => routeRoll(tab, null));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'roll-random') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  routeRoll(tab, null);
});

// Help-page opener (content scripts can't open chrome-extension:// pages
// directly from a web page context).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'YTRA_OPEN_HELP') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});

// Tagging-progress badge + hover title, driven from storage so it's correct
// even right after the service worker wakes.
async function refreshBadge() {
  const { [BUCKETS_KEY]: b } = await chrome.storage.local.get(BUCKETS_KEY);
  const inProgress = b?.total > 0 && b.tagged < b.total;
  chrome.action.setBadgeBackgroundColor({ color: '#c00' });
  chrome.action.setBadgeText({
    text: inProgress ? `${Math.floor((b.tagged / b.total) * 100)}%` : '',
  });
  chrome.action.setTitle({
    title: inProgress
      ? `Album Roulette — play a random album (tagging genres: ${b.tagged}/${b.total})`
      : 'Album Roulette — play a random album',
  });
}

// ---- genre-lookup fetches --------------------------------------------------
// Done here rather than in the content script: extension-context fetches with
// host permissions are CORS-exempt, and iTunes' Access-Control-Allow-Origin
// header is flaky (sometimes absent on cached 200s).

const FETCH_ALLOWED = ['https://itunes.apple.com/', 'https://musicbrainz.org/'];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'YTRA_FETCH_JSON') return;
  if (!FETCH_ALLOWED.some((p) => (msg.url || '').startsWith(p))) {
    sendResponse({ status: 0, error: 'host not allowed' });
    return;
  }
  fetch(msg.url)
    .then(async (res) => sendResponse({ status: res.status, json: res.ok ? await res.json() : null }))
    .catch((e) => sendResponse({ status: 0, error: String(e) }));
  return true; // keep the message channel open for the async response
});

// ---- toolbar-icon context menu (right-click the extension icon) ----------

async function rebuildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'roll', title: '🎲 Random album', contexts: ['action'] });
  const { [BUCKETS_KEY]: b } = await chrome.storage.local.get(BUCKETS_KEY);
  if (!b?.counts) return;
  chrome.contextMenus.create({ id: 'sep', type: 'separator', contexts: ['action'] });
  for (const bucket of b.order || Object.keys(b.counts)) {
    const count = b.counts[bucket];
    if (!count) continue;
    chrome.contextMenus.create({
      id: `roll:${bucket}`,
      title: `${b.labels?.[bucket] || bucket} (${count})`,
      contexts: ['action'],
    });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  rebuildMenus();
  refreshBadge();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  }
});
chrome.runtime.onStartup.addListener(() => {
  rebuildMenus();
  refreshBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[BUCKETS_KEY]) {
    rebuildMenus();
    refreshBadge();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'roll') routeRoll(tab, null);
  else if (String(info.menuItemId).startsWith('roll:')) {
    routeRoll(tab, String(info.menuItemId).slice(5));
  }
});
