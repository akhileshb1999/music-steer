import {
  CALLS_PER_HOUR, PICK_COUNT,
  addToHistory, getApiKey, getControls, getHistory, getNowPlaying,
  getSteeringOn, getRecentCalls, recordCall, getPicks, setPicks
} from './lib/state.js';
import { buildPayload, filterPicks } from './lib/prompt.js';
import { requestPicks } from './lib/anthropic.js';

const DEBOUNCE_MS = 1500;        // wait for slider dragging / typing to settle before calling the API
const SPARE_PICKS = 2;           // ask for a couple extra in case some get filtered out
const LOADING_STALE_MS = 120000; // a "loading" state older than this was interrupted (worker killed)

// Clicking the toolbar icon opens the side panel (from any tab, so you can steer while browsing elsewhere).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Picks ---------------------------------------------------------------

let inFlight = false;

async function fetchPicks(trigger) {
  if (inFlight) return;
  const prev = await getPicks();
  if (prev && prev.status === 'loading' && Date.now() - prev.startedAt < LOADING_STALE_MS) return;

  const base = { songs: [], ...(prev || {}) };
  const fail = (error) => setPicks({ ...base, status: 'error', error, updatedAt: Date.now() });

  const apiKey = await getApiKey();
  if (!apiKey) return fail('Add your Anthropic API key in Options.');

  const calls = await getRecentCalls();
  if (calls.length >= CALLS_PER_HOUR) {
    const mins = Math.ceil((calls[0] + 3600000 - Date.now()) / 60000);
    return fail(`Hourly limit reached (${CALLS_PER_HOUR} calls). Next call available in ${mins} min.`);
  }

  inFlight = true;
  await setPicks({ ...base, status: 'loading', startedAt: Date.now(), error: null, trigger });
  try {
    const [controls, history, nowPlaying] = await Promise.all([getControls(), getHistory(), getNowPlaying()]);
    const payload = buildPayload({ controls, nowPlaying, history, count: PICK_COUNT + SPARE_PICKS });
    await recordCall();
    const { songs, usage } = await requestPicks(apiKey, payload);
    const picks = filterPicks(songs, {
      nowPlaying, history, avoidArtists: controls.avoidArtists, count: PICK_COUNT
    });
    await setPicks({
      status: picks.length ? 'ready' : 'error',
      error: picks.length ? null : 'Claude returned no usable songs. Try again or loosen the controls.',
      songs: picks,
      basedOn: nowPlaying ? { title: nowPlaying.title, artist: nowPlaying.artist } : null,
      usage: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null,
      dropped: songs.length - picks.length,
      trigger,
      updatedAt: Date.now()
    });
  } catch (err) {
    await fail(err.message || String(err));
  } finally {
    inFlight = false;
  }
}

let debounceTimer = null;
function schedulePicks(trigger) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => fetchPicks(trigger), DEBOUNCE_MS);
}

// While steering is on, a control change refreshes the picks.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.steeringOn && changes.steeringOn.newValue) {
    const picks = await getPicks();
    if (!picks || !picks.songs || !picks.songs.length) schedulePicks('steering-on');
    return;
  }
  if (changes.controls && await getSteeringOn()) schedulePicks('controls');
});

// ---- Messages ------------------------------------------------------------

const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return;
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);

  // From the YouTube Music tab (via bridge.js).
  if (origin === 'https://music.youtube.com' && sender.tab) {
    const tabId = sender.tab.id;
    switch (msg.type) {
      case 'nowPlaying':
        chrome.storage.session.set({ nowPlaying: { ...msg.track, tabId, updatedAt: Date.now() } });
        break;
      case 'trackPlayed':
        if (msg.track && msg.track.title) addToHistory(msg.track);
        break;
    }
    return;
  }

  // From the side panel (or any other extension page).
  if (origin !== EXTENSION_ORIGIN) return;
  if (msg.type === 'getPicks') {
    clearTimeout(debounceTimer);
    fetchPicks('manual');
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { nowPlaying } = await chrome.storage.session.get('nowPlaying');
  if (nowPlaying && nowPlaying.tabId === tabId) await chrome.storage.session.remove('nowPlaying');
});
