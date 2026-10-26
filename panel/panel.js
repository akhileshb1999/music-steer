import {
  DEFAULT_CONTROLS, STALE_AFTER_MS,
  getControls, setControls, getApiKey, getHistory, clearHistory, getNowPlaying, norm
} from '../lib/state.js';

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

const GENRE_SUGGESTIONS = [
  'hard rock', 'blues rock', 'classic rock', 'progressive rock', 'psychedelic rock', 'alternative rock',
  'indie rock', 'grunge', 'punk', 'post-punk', 'heavy metal', 'doom metal', 'stoner rock', 'folk',
  'folk rock', 'country', 'americana', 'blues', 'soul', 'funk', 'r&b', 'jazz', 'jazz fusion',
  'hip hop', 'trip hop', 'electronic', 'ambient', 'synthpop', 'new wave', 'shoegaze', 'dream pop',
  'pop', 'singer-songwriter', 'reggae', 'latin', 'afrobeat', 'classical'
];

const SLIDERS = [
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

$('steer').addEventListener('input', (e) => { controls.steer = e.target.value; save(); });
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
  renderAlbums();
  renderSteer();
}

$('resetControls').addEventListener('click', () => {
  if (!confirm('Reset all controls to defaults?')) return;
  controls = structuredClone(DEFAULT_CONTROLS);
  save();
  renderControls();
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
    return;
  }
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

$('clearHistory').addEventListener('click', async () => {
  if (!confirm('Clear play history?')) return;
  await clearHistory();
});

// ---- API key banner + options ------------------------------------------------

async function renderKeyWarning() {
  $('keyWarning').hidden = !!(await getApiKey());
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
  if (area === 'local') {
    if (changes.history) renderHistory(changes.history.newValue || []);
    if (changes.apiKey) renderKeyWarning();
    // Controls changed somewhere else (another panel window, later: presets).
    if (changes.controls && JSON.stringify(changes.controls.newValue) !== JSON.stringify(controls)) {
      controls = { ...structuredClone(DEFAULT_CONTROLS), ...(changes.controls.newValue || {}) };
      renderControls();
    }
  }
});

$('npArt').addEventListener('error', () => { $('npArt').hidden = true; });

// Re-check staleness even when no messages arrive (tab closed, navigated away).
setInterval(renderNowPlaying, 5000);

renderControls();
renderNowPlaying();
renderHistory();
renderKeyWarning();
