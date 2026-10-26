// Storage layout and defaults. Shared by the service worker, side panel and options page.
//
// chrome.storage.local   provider, apiKey (Anthropic), geminiKey, geminiModel,
//                        controls, history, steeringOn, callLog, dislikes, presets,
//                        library (artists from your YTM library), lastApplied + drift (gradual drift)
// chrome.storage.session nowPlaying (live state from the YTM tab), steer (steered queue + status)

export const HISTORY_LIMIT = 200;   // kept for "artists I know"; prompts use the last 20
export const STALE_AFTER_MS = 25000; // no heartbeat from the YTM tab for this long = disconnected
export const CALLS_PER_HOUR = 20;    // spend guard on Anthropic API calls
export const MIN_AHEAD = 3;          // top up when fewer steered songs than this are waiting
export const TARGET_AHEAD = 5;       // ...back up to this many
export const DISLIKES_LIMIT = 100;

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
  steerSetAt: null,      // when the steer text last changed (to count songs played since)
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

// Which AI picks the songs, and its credentials. Gemini (free tier) is the default.
export async function getAiSettings() {
  const s = await chrome.storage.local.get(['provider', 'apiKey', 'geminiKey', 'geminiModel']);
  return {
    provider: s.provider === 'anthropic' ? 'anthropic' : 'gemini',
    apiKey: s.apiKey || '',
    geminiKey: s.geminiKey || '',
    geminiModel: s.geminiModel || ''
  };
}

export async function setAiSettings(patch) {
  await chrome.storage.local.set(patch);
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
  return (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function getSteeringOn() {
  const { steeringOn } = await chrome.storage.local.get('steeringOn');
  return !!steeringOn;
}

export async function setSteeringOn(on) {
  await chrome.storage.local.set({ steeringOn: !!on });
}

// Timestamps of API calls in the last hour.
export async function getRecentCalls() {
  const { callLog } = await chrome.storage.local.get('callLog');
  const cutoff = Date.now() - 3600000;
  return (callLog || []).filter((t) => t > cutoff);
}

export async function recordCall() {
  const calls = await getRecentCalls();
  calls.push(Date.now());
  await chrome.storage.local.set({ callLog: calls });
  return calls;
}

// The steered queue as the service worker last saw it, plus what it is doing right now.
//   status: 'idle' | 'working' | 'ok' | 'error'
//   items:  [{ title, artist, album, reason, videoId, status: 'playing' | 'queued', addedAt }]
//   skip:   recently removed or not-found songs, so they aren't picked again this session
export const EMPTY_STEER = { status: 'idle', detail: '', error: null, items: [], skip: [], usage: null, updatedAt: 0 };

export async function getSteer() {
  const { steer } = await chrome.storage.session.get('steer');
  return { ...EMPTY_STEER, ...(steer || {}) };
}

export async function updateSteer(patch) {
  const next = { ...(await getSteer()), ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ steer: next });
  return next;
}

// Thumbs-down list, newest first: [{ title, artist, reason, at }]
export async function getDislikes() {
  const { dislikes } = await chrome.storage.local.get('dislikes');
  return dislikes || [];
}

export async function setDislikes(dislikes) {
  await chrome.storage.local.set({ dislikes: dislikes.slice(0, DISLIKES_LIMIT) });
}

export async function addDislike(song) {
  const list = (await getDislikes()).filter((d) => !sameTrack(d, song));
  list.unshift({ title: song.title, artist: song.artist, reason: song.reason || '', at: Date.now() });
  await setDislikes(list);
}

// Presets: { [name]: controls }
export async function getPresets() {
  const { presets } = await chrome.storage.local.get('presets');
  return presets || {};
}

export async function setPresets(presets) {
  await chrome.storage.local.set({ presets });
}

// Artists from your YouTube Music library, refreshed about once a day: { artists, fetchedAt, error }
export async function getLibrary() {
  const { library } = await chrome.storage.local.get('library');
  return library || null;
}

export async function setLibrary(library) {
  await chrome.storage.local.set({ library });
}
