// Storage layout and defaults. Shared by the service worker, side panel and options page.
//
// chrome.storage.local   apiKey, controls, history (persist across browser restarts)
// chrome.storage.session nowPlaying (live state from the YTM tab)

export const HISTORY_LIMIT = 200;   // kept for "artists I know"; prompts use the last 20
export const STALE_AFTER_MS = 25000; // no heartbeat from the YTM tab for this long = disconnected

export const DEFAULT_CONTROLS = {
  genres: [],            // [{ name, weight }]  weight is 0..100, normalized for display/prompt
  excludeGenres: [],     // [name]
  energy: 50,            // 0 calm .. 100 intense
  heaviness: 50,         // 0 soft .. 100 heavy
  tempo: 50,             // 0 slow .. 100 fast
  eraFrom: null,         // decade start year (e.g. 1970) or null = any
  eraTo: null,           // decade start year or null = any
  popularity: 50,        // 0 hits .. 100 deep cuts
  discovery: 50,         // 0 artists I know .. 100 new to me
  seedArtists: [],       // [{ name, note }]  note = which side of the artist ("70s prog, not the pop singles")
  avoidArtists: [],      // [name]
  albums: [],            // [{ title, artist, mode: 'pull' | 'reference' }]
  steer: '',             // free-text steer
  driftMode: 'snap',     // 'snap' | 'gradual'
  driftSongs: 5          // songs to shift over when gradual
};

export async function getControls() {
  const { controls } = await chrome.storage.local.get('controls');
  return { ...structuredClone(DEFAULT_CONTROLS), ...(controls || {}) };
}

export async function setControls(controls) {
  await chrome.storage.local.set({ controls });
}

export async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey || '';
}

export async function setApiKey(apiKey) {
  await chrome.storage.local.set({ apiKey });
}

export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return history || [];
}

// Newest first. Skips a repeat of the song already at the top (e.g. a page reload mid-song).
export async function addToHistory(track) {
  const history = await getHistory();
  const top = history[0];
  if (top && sameTrack(top, track)) return history;
  const entry = {
    videoId: track.videoId || null,
    title: track.title,
    artist: track.artist,
    album: track.album || '',
    year: track.year || null,
    playedAt: Date.now()
  };
  const next = [entry, ...history].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ history: next });
  return next;
}

export async function clearHistory() {
  await chrome.storage.local.set({ history: [] });
}

export async function getNowPlaying() {
  const { nowPlaying } = await chrome.storage.session.get('nowPlaying');
  return nowPlaying || null;
}

export function sameTrack(a, b) {
  if (a.videoId && b.videoId) return a.videoId === b.videoId;
  return norm(a.title) === norm(b.title) && norm(a.artist) === norm(b.artist);
}

export function norm(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
