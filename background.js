import {
  CALLS_PER_HOUR, MIN_AHEAD, TARGET_AHEAD, STALE_AFTER_MS,
  addToHistory, getAiSettings, getControls, getHistory, getNowPlaying, getSteeringOn,
  getRecentCalls, recordCall, getSteer, updateSteer, getDislikes, addDislike,
  getLibrary, setLibrary
} from './lib/state.js';
import { buildPayload, filterPicks } from './lib/prompt.js';
import { requestPicks, keyFor, providerName } from './lib/llm.js';
import { effectiveControls, nextDrift, sameDirection } from './lib/drift.js';
import { reconcile, addSkips, spreadArtists } from './lib/queue.js';

const CONTROLS_SETTLE_MS = 1500;          // wait for slider dragging / typing to settle
const TRACK_SETTLE_MS = 2500;             // let the queue update after a song change
const SPARE_PICKS = 2;                    // ask for a couple extra; some get filtered or aren't on YTM
const RETRY_AFTER_ERROR_MS = 60000;       // automatic triggers back off this long after a failure
const RETRY_AFTER_QUEUE_BROKEN_MS = 30 * 60000;
const LIBRARY_MAX_AGE_MS = 24 * 3600000;
const LIBRARY_RETRY_MS = 6 * 3600000;
const HISTORY_BLOCK = 50;                 // never re-queue a song played this recently

// Messages shown to the user as-is (no stack, no "Error:" prefix).
class UserError extends Error {}

// Clicking the toolbar icon opens the side panel (from any tab, so you can steer while browsing elsewhere).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });

// ---- Talking to the YouTube Music tab ------------------------------------------------

async function ytmTab() {
  const np = await getNowPlaying();
  if (!np || Date.now() - np.updatedAt > STALE_AFTER_MS) throw new UserError('Open YouTube Music and play something.');
  return np;
}

async function ytm(op, args = {}, timeout = 20000) {
  const np = await ytmTab();
  let res;
  try {
    res = await chrome.tabs.sendMessage(np.tabId, { type: 'ytm', op, args, timeout }, { frameId: 0 });
  } catch {
    throw new UserError('Can’t reach the YouTube Music tab. Reload it and try again.');
  }
  if (!res) throw new UserError('The YouTube Music tab didn’t answer. Reload it and try again.');
  if (!res.ok) throw new UserError(`YouTube Music: ${res.error}`);
  return res.result;
}

// ---- Steered queue bookkeeping ---------------------------------------------------------

async function setWorking(detail) {
  await updateSteer({ status: 'working', detail, error: null });
}

async function refreshLibrary() {
  const lib = await getLibrary();
  const age = lib ? Date.now() - lib.fetchedAt : Infinity;
  if (lib && age < (lib.error ? LIBRARY_RETRY_MS : LIBRARY_MAX_AGE_MS)) return;
  try {
    const r = await ytm('libraryArtists', {}, 60000);
    await setLibrary({ artists: r.artists, fetchedAt: Date.now(), error: r.loggedIn ? null : 'not signed in' });
  } catch (err) {
    await setLibrary({ artists: (lib && lib.artists) || [], fetchedAt: Date.now(), error: err.message });
  }
}

// ---- Asking the AI (Gemini or Claude, set in Options) --------------------------------------

async function askModel({ count, queued, skip }) {
  const ai = await getAiSettings();
  if (!keyFor(ai)) throw new UserError(`Add your ${providerName(ai)} API key in Options.`);
  const calls = await getRecentCalls();
  if (calls.length >= CALLS_PER_HOUR) {
    const mins = Math.ceil((calls[0] + 3600000 - Date.now()) / 60000);
    throw new UserError(`Hourly limit reached (${CALLS_PER_HOUR} AI calls). Steering resumes in ${mins} min.`);
  }
  const [controls, history, nowPlaying, dislikes, library, { drift }] = await Promise.all([
    getControls(), getHistory(), getNowPlaying(), getDislikes(), getLibrary(), chrome.storage.local.get('drift')
  ]);
  const eff = effectiveControls(controls, drift, history);
  const payload = buildPayload({
    controls: eff.controls, drift: eff.drift, nowPlaying, history, queued, disliked: dislikes,
    skipped: skip, libraryArtists: (library && library.artists) || [], count: count + SPARE_PICKS
  });
  await recordCall();
  const { songs, usage, model } = await requestPicks(ai, payload);
  await updateSteer({
    usage: usage ? { ...usage, model: model || null } : null,
    drift: eff.drift ? { step: eff.drift.step, of: eff.drift.of } : null
  });
  return filterPicks(songs, {
    nowPlaying, history, queued, disliked: dislikes, skipped: skip,
    avoidArtists: eff.controls.avoidArtists, maxPerArtist: eff.controls.maxPerArtist, count: count + SPARE_PICKS
  });
}

// ---- The steering pass -------------------------------------------------------------------
//
// 1. Read the queue and see which steered songs are playing / still waiting.
// 2. flush (snap change or Refresh): take the waiting steered songs out.
// 3. If fewer than MIN_AHEAD are waiting, ask the AI for enough to get back to TARGET_AHEAD,
//    find each on YouTube Music, and queue them right after the current song.
//
// "Play next" only inserts right after the current song, so to keep the order (older picks first)
// the waiting steered songs are taken out and everything is put back in order. Songs you queued
// yourself and YouTube's autoplay are never touched.

async function steer({ flush = false, manual = false } = {}) {
  if (!(await getSteeringOn())) return;
  const state = await getSteer();
  if (!manual && state.retryAt && Date.now() < state.retryAt) return;

  const np = await ytmTab();
  const queue = await ytm('getQueue');
  if (!queue.items.length) {
    throw new UserError('Couldn’t read the YouTube Music queue. Open the player (click the player bar) and try again.');
  }
  const rec = reconcile(state.items, queue, np);
  let items = rec.items;
  let skip = addSkips(state.skip, rec.removed, 'removed');
  await updateSteer({ items, skip });

  let ahead = items.filter((i) => i.status === 'queued');
  if (flush && ahead.length) {
    await setWorking('Clearing the old picks…');
    const res = await ytm('remove', { videoIds: ahead.map((a) => a.videoId) }, 60000);
    const out = new Set(res.results.filter((r) => r.ok).map((r) => r.videoId));
    items = items.filter((i) => !(i.status === 'queued' && out.has(i.videoId)));
    ahead = items.filter((i) => i.status === 'queued');
    await updateSteer({ items });
  }

  const need = TARGET_AHEAD - ahead.length;
  if ((!flush && ahead.length >= MIN_AHEAD) || need <= 0) {
    await updateSteer({ status: 'ok', detail: '', error: null, retryAt: 0 });
    return;
  }

  await refreshLibrary();
  const history = await getHistory();
  const blocked = new Set([
    ...queue.items.slice(Math.max(0, queue.selectedIndex)).flatMap((q) => q.videoIds),
    ...history.slice(0, HISTORY_BLOCK).map((h) => h.videoId).filter(Boolean)
  ]);

  const found = [];
  const notFound = [];
  let searchError = null;
  for (let round = 0; round < 2 && found.length < need; round++) {
    const who = providerName(await getAiSettings());
    await setWorking(round ? `Asking ${who} for a few more…` : `Asking ${who} for ${need} song${need > 1 ? 's' : ''}…`);
    const picks = await askModel({ count: need - found.length, queued: [...ahead, ...found], skip: addSkips(skip, notFound, 'not_found') });
    await setWorking('Finding them on YouTube Music…');
    for (const p of picks) {
      if (found.length >= need) break;
      let m = null;
      try {
        m = await ytm('search', { title: p.title, artist: p.artist, album: p.album });
      } catch (err) {
        searchError = err;
        continue;
      }
      if (!m) { notFound.push(p); continue; }
      if (blocked.has(m.videoId)) continue;
      blocked.add(m.videoId);
      found.push({ title: p.title, artist: p.artist, album: p.album, reason: p.reason, videoId: m.videoId, matched: `${m.title} · ${m.artist}` });
    }
    if (!picks.length) break;
  }
  skip = addSkips(skip, notFound, 'not_found');
  await updateSteer({ skip });
  if (!found.length) {
    if (searchError) throw searchError;
    throw new UserError('None of the picks could be found on YouTube Music. Try again, or loosen the controls.');
  }
  if (!(await getSteeringOn())) return;

  // Same-artist rule: keep new songs apart from each other and from whatever plays just before them.
  const controls = await getControls();
  let spreadOut = [];
  if (!controls.allowBackToBack) {
    const before = ahead.length ? ahead[ahead.length - 1].artist : np.artist;
    const spread = spreadArtists(found, before);
    found.splice(0, found.length, ...spread.songs);
    spreadOut = spread.dropped;
  }
  if (!found.length) {
    throw new UserError('All the picks were by the artist playing now. Allow back-to-back in Artists, or press Refresh.');
  }

  await setWorking('Adding to the queue…');
  let sequence = found;
  let stayed = [];
  if (ahead.length) {
    const res = await ytm('remove', { videoIds: ahead.map((a) => a.videoId) }, 60000);
    const out = new Set(res.results.filter((r) => r.ok).map((r) => r.videoId));
    sequence = [...ahead.filter((a) => out.has(a.videoId)), ...found];
    stayed = ahead.filter((a) => !out.has(a.videoId));
  }
  const added = await ytm('playNext', { videoIds: sequence.map((s) => s.videoId) }, 150000);
  const ok = new Set(added.results.filter((r) => r.ok).map((r) => r.videoId));
  const now = Date.now();
  items = [
    ...items.filter((i) => i.status === 'playing'),
    ...sequence.filter((s) => ok.has(s.videoId)).map((s) => ({ ...s, status: 'queued', addedAt: s.addedAt || now })),
    ...stayed
  ];

  if (!ok.size) {
    await updateSteer({ items, retryAt: now + RETRY_AFTER_QUEUE_BROKEN_MS, diag: added.diagnostics || null });
    throw new UserError('Couldn’t add songs to the YouTube Music queue (YouTube may have changed something). Press Refresh to try again.');
  }
  const notes = [];
  if (notFound.length) notes.push(`Not on YouTube Music: ${notFound.map((p) => `${p.title} (${p.artist})`).join(', ')}`);
  if (spreadOut.length) notes.push(`Left out to avoid back-to-back artists: ${spreadOut.map((p) => `${p.title} (${p.artist})`).join(', ')}`);
  if (ok.size < sequence.length) notes.push(`${sequence.length - ok.size} song(s) couldn’t be added.`);
  await updateSteer({ items, status: 'ok', detail: '', error: null, note: notes.join(' · '), retryAt: 0, filledAt: now, diag: added.diagnostics || null });
}

// ---- One thing at a time -------------------------------------------------------------------
//
// Steering passes and panel actions run one after another. Repeated steering requests collapse into
// one (the strongest kind wins: manual refresh > refresh > top-up).

const RANK = { topup: 0, refresh: 1, manual: 2 };
const tasks = [];
let busy = false;

function enqueue(kind, fn) {
  if (kind in RANK) {
    const queued = tasks.find((t) => t.kind in RANK);
    if (queued) {
      if (RANK[kind] > RANK[queued.kind]) queued.kind = kind;
      return;
    }
  }
  tasks.push({ kind, fn });
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  // Long passes (AI call + searches + inserts) mustn't let the service worker go idle.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    while (tasks.length) {
      const t = tasks.shift();
      try {
        if (t.fn) await t.fn();
        else await steer({ flush: t.kind !== 'topup', manual: t.kind === 'manual' });
      } catch (err) {
        const state = await getSteer();
        const message = err instanceof UserError || err.name === 'Error' ? err.message : String(err);
        await updateSteer({
          status: 'error', detail: '', error: message,
          retryAt: Math.max(state.retryAt || 0, Date.now() + RETRY_AFTER_ERROR_MS)
        });
      }
    }
  } finally {
    clearInterval(keepAlive);
    busy = false;
  }
}

const timers = {};
function later(name, ms, fn) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(fn, ms);
}

// ---- Panel actions ---------------------------------------------------------------------------

async function removeSteered(videoId, { dislike = false } = {}) {
  const state = await getSteer();
  const item = state.items.find((i) => i.videoId === videoId);
  if (dislike && item) await addDislike(item);
  if (item && item.status === 'queued') {
    try {
      const res = await ytm('remove', { videoIds: [videoId] }, 60000);
      if (!res.results[0].ok) {
        await updateSteer({ status: 'error', error: 'Couldn’t remove that song from the YouTube Music queue.', diag: res.diagnostics || null });
        return;
      }
    } catch (err) {
      await updateSteer({ status: 'error', error: err.message });
      return;
    }
  }
  const fresh = await getSteer();
  await updateSteer({
    items: fresh.items.filter((i) => !(i.videoId === videoId && i.status === 'queued')),
    skip: item ? addSkips(fresh.skip, [item], dislike ? 'disliked' : 'removed') : fresh.skip
  });
  enqueue('topup');
}

// ---- Triggers --------------------------------------------------------------------------------

async function onControlsSettled() {
  const controls = await getControls();
  const { lastApplied, drift } = await chrome.storage.local.get(['lastApplied', 'drift']);
  if (lastApplied && sameDirection(lastApplied, controls)) {
    await chrome.storage.local.set({ lastApplied: controls });
    return;
  }
  if (!(await getSteeringOn())) {
    await chrome.storage.local.set({ lastApplied: controls, drift: null });
    return;
  }
  const next = nextDrift({ controls, lastApplied, drift, history: await getHistory() });
  await chrome.storage.local.set(next);
  // Gradual: keep what's queued and let new picks follow the moving target. Snap: replace now.
  enqueue(next.drift ? 'topup' : 'refresh');
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.steeringOn) {
    if (changes.steeringOn.newValue) {
      await chrome.storage.local.set({ lastApplied: await getControls(), drift: null });
      enqueue('topup');
    } else {
      await updateSteer({ status: 'idle', detail: '', error: null });
    }
  }
  if (changes.controls) later('controls', CONTROLS_SETTLE_MS, onControlsSettled);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat' && await getSteeringOn()) enqueue('topup');
});

const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
const trackKey = (t) => (t ? t.videoId || `${t.title}|${t.artist}` : '');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || sender.id !== chrome.runtime.id) return;
  const origin = sender.origin || (sender.url && new URL(sender.url).origin);

  // From the YouTube Music tab (via bridge.js).
  if (origin === 'https://music.youtube.com' && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.type === 'nowPlaying') {
      (async () => {
        const prev = await getNowPlaying();
        await chrome.storage.session.set({ nowPlaying: { ...msg.track, tabId, updatedAt: Date.now() } });
        if (trackKey(prev) !== trackKey(msg.track) && await getSteeringOn()) {
          later('track', TRACK_SETTLE_MS, () => enqueue('topup'));
        }
      })();
    } else if (msg.type === 'trackPlayed' && msg.track && msg.track.title) {
      addToHistory(msg.track);
    }
    return;
  }

  // From the side panel (or any other extension page).
  if (origin !== EXTENSION_ORIGIN) return;
  switch (msg.type) {
    case 'refresh':
      enqueue('manual');
      break;
    case 'removeSteered':
      enqueue('remove', () => removeSteered(msg.videoId));
      break;
    case 'dislikeSteered':
      enqueue('remove', () => removeSteered(msg.videoId, { dislike: true }));
      break;
    case 'dislikeNowPlaying':
      getNowPlaying().then((np) => np && addDislike(np)).then(() => sendResponse({ ok: true }));
      return true;
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const np = await getNowPlaying();
  if (np && np.tabId === tabId) await chrome.storage.session.remove('nowPlaying');
});
