import { addToHistory } from './lib/state.js';

// Clicking the toolbar icon opens the side panel (from any tab, so you can steer while browsing elsewhere).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab || !msg || typeof msg.type !== 'string') return;
  const tabId = sender.tab.id;

  switch (msg.type) {
    case 'nowPlaying':
      chrome.storage.session.set({ nowPlaying: { ...msg.track, tabId, updatedAt: Date.now() } });
      break;
    case 'trackPlayed':
      if (msg.track && msg.track.title) addToHistory(msg.track);
      break;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { nowPlaying } = await chrome.storage.session.get('nowPlaying');
  if (nowPlaying && nowPlaying.tabId === tabId) await chrome.storage.session.remove('nowPlaying');
});
