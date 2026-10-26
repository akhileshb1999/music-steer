import {
  DEFAULT_CONTROLS, STALE_AFTER_MS, CALLS_PER_HOUR,
  getControls, setControls, getAiSettings, getHistory, clearHistory, getNowPlaying, norm,
  getSteeringOn, setSteeringOn, getSteer, getRecentCalls, getLibrary,
  getDislikes, setDislikes, getPresets, setPresets
} from '../lib/state.js';
import { keyFor, providerName } from '../lib/llm.js';

const $ = (id) => document.getElementById(id);

// Small DOM builder: h('div', { class: 'x', onclick: fn }, child, 'text')
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

// Two-click confirm (native confirm() dialogs aren't reliable in side panels).
function confirmClick(button, action) {
  const label = button.textContent;
  let armed = null;
  button.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      button.textContent = label;
      action();
      return;
    }
    button.textContent = 'Click again to confirm';
    armed = setTimeout(() => { armed = null; button.textContent = label; }, 3000);
  });
}

const GENRE_SUGGESTIONS = [
  'hard rock', 'blues rock', 'classic rock', 'progressive rock', 'psychedelic rock', 'alternative rock',
  'indie rock', 'grunge', 'punk', 'post-punk', 'heavy metal', 'doom metal', 'stoner rock', 'folk',
  'folk rock', 'country', 'americana', 'blues', 'soul', 'funk', 'r&b', 'jazz', 'jazz fusion',
  'hip hop', 'trip hop', 'electronic', 'ambient', 'synthpop', 'new wave', 'shoegaze', 'dream pop',
  'pop', 'singer-songwriter', 'reggae', 'latin', 'afrobeat', 'classical'
];

const SLIDERS = [
  { key: 'vibe', name: 'Current vibe', left: 'Follow my controls', right: 'Stay close to what’s playing' },
  { key: 'energy', name: 'Energy', left: 'Calm', right: 'Intense' },
  { key: 'heaviness', name: 'Heaviness', left: 'Soft', right: 'Heavy' },
  { key: 'tempo', name: 'Tempo', left: 'Slow', right: 'Fast' },
  { key: 'popularity', name: 'Popularity', left: 'Hits', right: 'Deep cuts' },
  { key: 'discovery', name: 'Discovery', left: 'Artists I know', right: 'New to me' }
];

let controls = await getControls();

// ---- Saving --------------------------------------------------------------

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  $('saved').textContent = 'Saving…';
  saveTimer = setTimeout(async () => {
    await setControls(controls);
    $('saved').textContent = 'Saved';
  }, 300);
}

// ---- Chip lists (exclude genres, avoid artists) ---------------------------

function renderChips(container, key, placeholder) {
  container.replaceChildren(
    ...controls[key].map((item, i) =>
      h('span', { class: 'chip' }, item,
        h('button', {
          class: 'icon', type: 'button', title: `Remove ${item}`, 'aria-label': `Remove ${item}`,
          onclick: () => { controls[key].splice(i, 1); save(); renderChips(container, key, placeholder); }
        }, '✕'))),
    h('input', {
      placeholder, 'aria-label': placeholder,
      onkeydown: (e) => {
        if (e.key !== 'Enter' && e.key !== ',') return;
        e.preventDefault();
        const value = e.target.value.trim();
        if (value && !controls[key].some((x) => norm(x) === norm(value))) {
          controls[key].push(value);
          save();
        }
        renderChips(container, key, placeholder);
        container.querySelector('input').focus();
      }
    })
  );
}

// ---- Genres -----------------------------------------------------------------

function renderGenres() {
  const total = controls.genres.reduce((s, g) => s + g.weight, 0);
  const pct = (w) => (total ? Math.round((w / total) * 100) : 0);
  $('genreList').replaceChildren(
    ...controls.genres.map((g, i) => {
      const label = h('span', { class: 'pct' }, `${pct(g.weight)}%`);
      return h('div', { class: 'row-item genre-row' },
        h('span', { class: 'name' }, g.name),
        h('input', {
          type: 'range', min: 0, max: 100, value: g.weight, 'aria-label': `${g.name} weight`,
          oninput: (e) => {
            g.weight = Number(e.target.value);
            save();
            // Update every percentage without re-rendering (keeps the slider being dragged).
            const t = controls.genres.reduce((s, x) => s + x.weight, 0);
            $('genreList').querySelectorAll('.pct').forEach((el, j) => {
              el.textContent = `${t ? Math.round((controls.genres[j].weight / t) * 100) : 0}%`;
            });
          }
        }),
        label,
        h('button', {
          class: 'icon', type: 'button', title: `Remove ${g.name}`, 'aria-label': `Remove ${g.name}`,
          onclick: () => { controls.genres.splice(i, 1); save(); renderGenres(); }
        }, '✕'));
    })
  );
  if (!controls.genres.length) {
    $('genreList').append(h('div', { class: 'muted' }, 'No genres yet. Add one, then set its weight.'));
  }
}

$('genreSuggestions').replaceChildren(...GENRE_SUGGESTIONS.map((g) => h('option', { value: g })));
$('genreAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('genreInput').value.trim();
  if (!name) return;
  if (!controls.genres.some((g) => norm(g.name) === norm(name))) {
    controls.genres.push({ name, weight: 50 });
    save();
  }
  $('genreInput').value = '';
  renderGenres();
});

// ---- Tone sliders + era --------------------------------------------------

function renderSliders() {
  $('sliders').replaceChildren(
    ...SLIDERS.map((s) => {
      const id = `slider-${s.key}`;
      return h('div', { class: 'slider' },
        h('div', { class: 'slider-head' },
          h('label', { class: 'slider-name', for: id }, s.name)),
        h('input', {
          id, type: 'range', min: 0, max: 100, value: controls[s.key],
          oninput: (e) => { controls[s.key] = Number(e.target.value); save(); }
        }),
        h('div', { class: 'slider-ends' }, h('span', {}, s.left), h('span', {}, s.right)));
    })
  );
}

function renderEra() {
  const decades = [];
  for (let y = 1940; y <= 2020; y += 10) decades.push(y);
  for (const [id, key] of [['eraFrom', 'eraFrom'], ['eraTo', 'eraTo']]) {
    $(id).replaceChildren(
      h('option', { value: '' }, 'Any'),
      ...decades.map((y) => h('option', { value: y }, `${y}s`))
    );
    $(id).value = controls[key] == null ? '' : String(controls[key]);
  }
}

for (const key of ['eraFrom', 'eraTo']) {
  $(key).addEventListener('change', (e) => {
    controls[key] = e.target.value ? Number(e.target.value) : null;
    // Keep the range ordered.
    if (controls.eraFrom != null && controls.eraTo != null && controls.eraFrom > controls.eraTo) {
      if (key === 'eraFrom') controls.eraTo = controls.eraFrom; else controls.eraFrom = controls.eraTo;
      renderEra();
    }
    save();
  });
}

// ---- Seed artists ---------------------------------------------------------

function renderSeeds() {
  $('seedList').replaceChildren(
    ...controls.seedArtists.map((a, i) =>
      h('div', { class: 'row-item seed-row' },
        h('span', { class: 'name' }, a.name),
        h('input', {
          value: a.note || '', placeholder: 'Which side? e.g. 70s prog, not the pop singles',
          'aria-label': `Note for ${a.name}`,
          oninput: (e) => { a.note = e.target.value; save(); }
        }),
        h('button', {
          class: 'icon', type: 'button', title: `Remove ${a.name}`, 'aria-label': `Remove ${a.name}`,
          onclick: () => { controls.seedArtists.splice(i, 1); save(); renderSeeds(); }
        }, '✕')))
  );
}

$('seedAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('seedInput').value.trim();
  if (!name) return;
  if (!controls.seedArtists.some((a) => norm(a.name) === norm(name))) {
    controls.seedArtists.push({ name, note: '' });
    save();
  }
  $('seedInput').value = '';
  renderSeeds();
});

// ---- Same-artist rules ------------------------------------------------------

function renderSameArtist() {
  $('maxPerArtist').value = controls.maxPerArtist;
  $('allowBackToBack').checked = !!controls.allowBackToBack;
}

$('maxPerArtist').addEventListener('change', (e) => {
  const n = Math.round(Number(e.target.value));
  controls.maxPerArtist = Math.min(5, Math.max(1, Number.isFinite(n) ? n : DEFAULT_CONTROLS.maxPerArtist));
  e.target.value = controls.maxPerArtist;
  save();
});
$('allowBackToBack').addEventListener('change', (e) => { controls.allowBackToBack = e.target.checked; save(); });

// ---- Albums -----------------------------------------------------------------

function renderAlbums() {
  $('albumList').replaceChildren(
    ...controls.albums.map((a, i) =>
      h('div', { class: 'row-item album-row' },
        h('span', { class: 'album-name' }, h('span', { class: 'name' }, a.title), a.artist ? ` · ${a.artist}` : ''),
        h('select', {
          'aria-label': `How to use ${a.title}`,
          onchange: (e) => { a.mode = e.target.value; save(); }
        },
        h('option', { value: 'pull', selected: a.mode === 'pull' }, 'Pull from'),
        h('option', { value: 'reference', selected: a.mode === 'reference' }, 'Reference')),
        h('button', {
          class: 'icon', type: 'button', title: `Remove ${a.title}`, 'aria-label': `Remove ${a.title}`,
          onclick: () => { controls.albums.splice(i, 1); save(); renderAlbums(); }
        }, '✕')))
  );
}

$('albumAdd').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('albumTitle').value.trim();
  if (!title) return;
  controls.albums.push({ title, artist: $('albumArtist').value.trim(), mode: $('albumMode').value });
  save();
  $('albumTitle').value = '';
  $('albumArtist').value = '';
  renderAlbums();
});

// ---- Steer + drift --------------------------------------------------------

function renderSteer() {
  $('steer').value = controls.steer;
  document.querySelectorAll('input[name=drift]').forEach((r) => { r.checked = r.value === controls.driftMode; });
  $('driftSongs').value = controls.driftSongs;
  $('driftSongsWrap').hidden = controls.driftMode !== 'gradual';
}

$('steer').addEventListener('input', (e) => {
  controls.steer = e.target.value;
  controls.steerSetAt = Date.now();
  save();
});
document.querySelectorAll('input[name=drift]').forEach((r) =>
  r.addEventListener('change', (e) => {
    controls.driftMode = e.target.value;
    $('driftSongsWrap').hidden = controls.driftMode !== 'gradual';
    save();
  }));
$('driftSongs').addEventListener('change', (e) => {
  const n = Math.round(Number(e.target.value));
  controls.driftSongs = Math.min(30, Math.max(2, Number.isFinite(n) ? n : DEFAULT_CONTROLS.driftSongs));
  e.target.value = controls.driftSongs;
  save();
});

// ---- Render all controls ----------------------------------------------------

function renderControls() {
  renderGenres();
  renderChips($('excludeGenres'), 'excludeGenres', 'Type a genre, press Enter');
  renderSliders();
  renderEra();
  renderSeeds();
  renderChips($('avoidArtists'), 'avoidArtists', 'Type an artist, press Enter');
  renderSameArtist();
  renderAlbums();
  renderSteer();
}

confirmClick($('resetControls'), () => {
  controls = structuredClone(DEFAULT_CONTROLS);
  save();
  renderControls();
});

// ---- Presets ---------------------------------------------------------------------

let presets = await getPresets();

function presetMsg(text) {
  $('presetMsg').textContent = text;
  setTimeout(() => { if ($('presetMsg').textContent === text) $('presetMsg').textContent = ''; }, 4000);
}

function renderPresets() {
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  const current = $('presetSelect').value;
  $('presetSelect').replaceChildren(
    names.length ? null : h('option', { value: '' }, 'No presets yet'),
    ...names.map((n) => h('option', { value: n }, n))
  );
  if (names.includes(current)) $('presetSelect').value = current;
  $('presetLoad').disabled = $('presetDelete').disabled = !names.length;
}

$('presetSave').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('presetName').value.trim();
  if (!name) return;
  presets = { ...presets, [name]: structuredClone(controls) };
  await setPresets(presets);
  $('presetName').value = '';
  renderPresets();
  $('presetSelect').value = name;
  presetMsg(`Saved “${name}”.`);
});

$('presetLoad').addEventListener('click', () => {
  const name = $('presetSelect').value;
  if (!presets[name]) return;
  controls = { ...structuredClone(DEFAULT_CONTROLS), ...structuredClone(presets[name]), steerSetAt: Date.now() };
  save();
  renderControls();
  presetMsg(`Loaded “${name}”.`);
});

confirmClick($('presetDelete'), async () => {
  const name = $('presetSelect').value;
  if (!presets[name]) return;
  const { [name]: _, ...rest } = presets;
  presets = rest;
  await setPresets(presets);
  renderPresets();
  presetMsg(`Deleted “${name}”.`);
});

$('presetExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ musicSteerPresets: 1, presets }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'music-steer-presets.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('presetImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = data && data.presets && typeof data.presets === 'object' ? data.presets : null;
    if (!incoming) throw new Error('not a Music Steer presets file');
    const clean = {};
    for (const [name, c] of Object.entries(incoming)) {
      if (c && typeof c === 'object' && Array.isArray(c.genres)) clean[String(name).slice(0, 80)] = { ...structuredClone(DEFAULT_CONTROLS), ...c };
    }
    presets = { ...presets, ...clean };
    await setPresets(presets);
    renderPresets();
    presetMsg(`Imported ${Object.keys(clean).length} preset(s).`);
  } catch (err) {
    presetMsg(`Import failed: ${err.message}`);
  }
});

// ---- Now playing + connection ----------------------------------------------

let nowPlaying = await getNowPlaying();

function renderNowPlaying() {
  const fresh = nowPlaying && Date.now() - nowPlaying.updatedAt < STALE_AFTER_MS;
  $('conn').classList.toggle('on', !!fresh);
  $('connText').textContent = fresh ? 'Connected to YTM' : 'Not connected';

  if (!nowPlaying) {
    $('npState').textContent = 'Now playing';
    $('npTitle').textContent = 'Open music.youtube.com and play something';
    $('npMeta').textContent = '';
    $('npArt').hidden = true;
    $('npDislike').hidden = true;
    return;
  }
  $('npDislike').hidden = !fresh;
  $('npState').textContent = !fresh ? 'Last seen' : nowPlaying.playing ? 'Now playing' : 'Paused';
  $('npTitle').textContent = nowPlaying.title;
  $('npMeta').textContent = [nowPlaying.artist, nowPlaying.album, nowPlaying.year].filter(Boolean).join(' · ');
  if (nowPlaying.artwork) {
    $('npArt').src = nowPlaying.artwork;
    $('npArt').hidden = false;
  } else {
    $('npArt').hidden = true;
  }
}

// ---- Steered queue ---------------------------------------------------------------

let steer = await getSteer();
let steeringOn = await getSteeringOn();
const WORKING_STALE_MS = 180000;

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function songRow(item) {
  const queued = item.status === 'queued';
  return h('li', { class: item.status },
    h('div', {},
      h('div', { class: 'badge' }, item.status === 'playing' ? 'Playing now' : 'Queued'),
      h('div', { class: 'song-title' }, item.title),
      h('div', { class: 'muted' }, [item.artist, item.album].filter(Boolean).join(' · ')),
      item.reason ? h('div', { class: 'song-reason' }, item.reason) : null),
    h('div', { class: 'song-actions' },
      h('button', {
        class: 'icon thumb', type: 'button', title: 'Thumbs down: remove it and steer away from songs like it',
        'aria-label': `Thumbs down ${item.title}`,
        onclick: () => chrome.runtime.sendMessage({ type: 'dislikeSteered', videoId: item.videoId })
      }, '👎'),
      queued ? h('button', {
        class: 'icon', type: 'button', title: 'Remove from the queue', 'aria-label': `Remove ${item.title} from the queue`,
        onclick: () => chrome.runtime.sendMessage({ type: 'removeSteered', videoId: item.videoId })
      }, '✕') : null));
}

function renderSteered() {
  const status = $('steerStatus');
  const stale = steer.status === 'working' && Date.now() - steer.updatedAt > WORKING_STALE_MS;
  const working = steer.status === 'working' && !stale;
  const queued = steer.items.filter((i) => i.status === 'queued').length;

  status.className = `steer-status ${working ? 'working' : steer.status === 'error' ? 'error' : 'muted'}`;
  $('refresh').disabled = working;
  if (!steeringOn) {
    status.textContent = 'Steering is off. Turn it on (or press Refresh) to keep steered songs queued.';
  } else if (working) {
    status.textContent = steer.detail || 'Working…';
  } else if (stale) {
    status.textContent = 'The last update was interrupted. It will retry shortly, or press Refresh.';
  } else if (steer.status === 'error') {
    status.textContent = steer.error;
  } else if (steer.status === 'ok') {
    status.textContent = `${queued} steered song${queued === 1 ? '' : 's'} queued` + (steer.filledAt ? ` · updated ${ago(steer.filledAt)}` : '');
  } else {
    status.textContent = 'Starting…';
  }

  $('driftStatus').hidden = !(steeringOn && steer.drift && controls.driftMode === 'gradual');
  if (steer.drift) $('driftStatus').textContent = `Drifting toward your new settings: song ${steer.drift.step + 1} of ${steer.drift.of}`;

  $('steerList').replaceChildren(...steer.items.map(songRow));
  if (!steer.items.length && steeringOn && steer.status !== 'working') {
    $('steerList').append(h('li', { class: 'empty-msg' }, 'No steered songs queued yet.'));
  }
  $('copyDiag').hidden = !(steer.status === 'error' && steer.diag);
  $('steerNote').hidden = !steer.note;
  $('steerNote').textContent = steer.note || '';
}

async function renderCallInfo() {
  const [calls, library, ai] = await Promise.all([getRecentCalls(), getLibrary(), getAiSettings()]);
  const parts = [`${providerName(ai)} calls this hour: ${calls.length}/${CALLS_PER_HOUR}`];
  if (steer.usage) {
    parts.push(`last: ${steer.usage.input.toLocaleString()} in / ${steer.usage.output.toLocaleString()} out tokens` +
      (steer.usage.model ? ` (${steer.usage.model})` : ''));
  }
  if (library && library.artists && library.artists.length) parts.push(`${library.artists.length} library artists known`);
  $('callInfo').textContent = parts.join(' · ');
}

$('copyDiag').addEventListener('click', async () => {
  const report = {
    version: chrome.runtime.getManifest().version,
    error: steer.error,
    diagnostics: steer.diag
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report));
    $('copyDiag').textContent = 'Copied. Paste it in the chat.';
  } catch {
    $('copyDiag').textContent = 'Couldn’t copy. Try again.';
  }
  setTimeout(() => { $('copyDiag').textContent = 'Copy details for troubleshooting'; }, 3000);
});

$('refresh').addEventListener('click', async () => {
  if (!steeringOn) await setSteeringOn(true);
  chrome.runtime.sendMessage({ type: 'refresh' });
});

$('steeringOn').checked = steeringOn;
$('steeringOn').addEventListener('change', (e) => setSteeringOn(e.target.checked));

$('npDislike').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'dislikeNowPlaying' });
  $('npDislike').textContent = '✓';
  setTimeout(() => { $('npDislike').textContent = '👎'; }, 1500);
});

// ---- Dislikes ------------------------------------------------------------------------

let dislikes = await getDislikes();
let dislikeSaveTimer = null;

function renderDislikes() {
  $('dislikeCount').textContent = dislikes.length ? `(${dislikes.length})` : '';
  $('dislikeList').replaceChildren(
    ...dislikes.map((d, i) =>
      h('li', {},
        h('span', { class: 'who' }, h('span', { class: 'name' }, d.title), h('span', { class: 'muted' }, ` · ${d.artist}`)),
        h('input', {
          value: d.reason || '', placeholder: 'Why? e.g. too slow', 'aria-label': `Reason for disliking ${d.title}`,
          oninput: (e) => {
            d.reason = e.target.value;
            clearTimeout(dislikeSaveTimer);
            dislikeSaveTimer = setTimeout(() => setDislikes(dislikes), 400);
          }
        }),
        h('button', {
          class: 'icon', type: 'button', title: 'Un-dislike', 'aria-label': `Remove ${d.title} from disliked`,
          onclick: () => { dislikes.splice(i, 1); setDislikes(dislikes); renderDislikes(); }
        }, '✕')))
  );
  if (!dislikes.length) $('dislikeList').append(h('li', { class: 'empty-msg' }, 'Nothing disliked yet. Use 👎 on a song.'));
  $('clearDislikes').hidden = !dislikes.length;
}

confirmClick($('clearDislikes'), async () => {
  dislikes = [];
  await setDislikes([]);
  renderDislikes();
});

// ---- History -----------------------------------------------------------------

async function renderHistory(history) {
  history = history || await getHistory();
  const recent = history.slice(0, 20);
  $('historyCount').textContent = history.length ? `(${recent.length})` : '';
  $('history').replaceChildren(
    ...recent.map((t) => h('li', {}, h('span', { class: 'name' }, t.title), h('span', { class: 'muted' }, ` · ${t.artist}`)))
  );
  if (!recent.length) $('history').append(h('li', { class: 'muted empty' }, 'Nothing yet. Songs appear after 30 s of play.'));
}

confirmClick($('clearHistory'), () => clearHistory());

// ---- API key banner + options ------------------------------------------------

async function renderKeyWarning() {
  const ai = await getAiSettings();
  $('keyWarning').hidden = !!keyFor(ai);
  $('keyWarningText').textContent = ai.provider === 'anthropic'
    ? 'No Anthropic API key yet.'
    : 'No AI key yet. Music Steer uses Google Gemini’s free tier: get a free key and paste it in';
}
for (const id of ['openOptions', 'openOptions2']) {
  $(id).addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
}

// ---- Live updates ------------------------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.nowPlaying) {
    nowPlaying = changes.nowPlaying.newValue || null;
    renderNowPlaying();
  }
  if (area === 'session' && changes.steer) {
    steer = { ...steer, ...(changes.steer.newValue || {}) };
    renderSteered();
    renderCallInfo();
  }
  if (area === 'local') {
    if (changes.history) renderHistory(changes.history.newValue || []);
    if (changes.apiKey || changes.geminiKey || changes.provider) { renderKeyWarning(); renderCallInfo(); }
    if (changes.callLog || changes.library) renderCallInfo();
    if (changes.steeringOn) {
      steeringOn = !!changes.steeringOn.newValue;
      $('steeringOn').checked = steeringOn;
      renderSteered();
    }
    if (changes.presets) { presets = changes.presets.newValue || {}; renderPresets(); }
    if (changes.dislikes && !document.activeElement.closest('#dislikeList')) {
      dislikes = changes.dislikes.newValue || [];
      renderDislikes();
    }
    // Controls changed somewhere else (another panel window, later: presets).
    if (changes.controls && JSON.stringify(changes.controls.newValue) !== JSON.stringify(controls)) {
      controls = { ...structuredClone(DEFAULT_CONTROLS), ...(changes.controls.newValue || {}) };
      renderControls();
    }
  }
});

$('npArt').addEventListener('error', () => { $('npArt').hidden = true; });

// Re-check staleness even when no messages arrive (tab closed, navigated away), and refresh "x min ago".
setInterval(() => { renderNowPlaying(); renderSteered(); renderCallInfo(); }, 5000);

renderControls();
renderNowPlaying();
renderHistory();
renderKeyWarning();
renderSteered();
renderCallInfo();
renderPresets();
renderDislikes();
