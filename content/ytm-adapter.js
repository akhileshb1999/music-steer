// MAIN-world script on music.youtube.com.
//
// Every piece of code that depends on how YouTube Music's page works lives in this file,
// so when YouTube changes something this is the only place to fix.
//
//   Now playing   navigator.mediaSession + the player's getVideoData(); queue/player-bar byline for the year
//   Search        POST /youtubei/v1/search (the page's own endpoint). The "Songs" filter value is read
//                 from the result chips, never hard-coded.
//   Queue (read)  .data on the rows of <ytmusic-player-queue>; the element's getState() as a fallback
//   Play next     the same queueAddEndpoint command the "Play next" menu item carries, handed to the
//                 app through its own 'yt-action' / 'yt-service-request' event
//   Remove        the row's own removeFromQueueEndpoint (from its menu data); clicking the row's
//                 "Remove from queue" menu entry as a fallback
//   Library       POST /youtubei/v1/browse for library artists, subscriptions and liked songs
//
// The extension talks to this file through content/bridge.js (window.postMessage both ways).
(() => {
  if (window.__musicSteerAdapter) return;
  window.__musicSteerAdapter = true;

  const PAGE = 'music-steer:page';
  const EXT = 'music-steer:ext';
  const POLL_MS = 1000;
  const HEARTBEAT_MS = 10000;
  const PLAYED_AFTER_S = 30; // seconds of actual playback before a song counts as "played"

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function post(type, track) {
    window.postMessage({ source: PAGE, type, track }, location.origin);
  }

  // ---- Generic helpers -------------------------------------------------------

  function runsText(t) {
    return (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';
  }

  // Every value stored under `key` anywhere inside `node` (robust to layout shuffles).
  function collect(node, key, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return out;
    if (Array.isArray(node)) {
      for (const x of node) collect(x, key, out, depth + 1);
      return out;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out, depth + 1);
    }
    return out;
  }

  function norm(s) {
    return (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function cfg(name) {
    try { return window.ytcfg && window.ytcfg.get(name); } catch { return undefined; }
  }

  function cookie(name) {
    for (const part of document.cookie.split('; ')) {
      const i = part.indexOf('=');
      if (part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
    }
    return null;
  }

  async function waitFor(check, timeoutMs, stepMs = 250) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (check()) return true;
      if (Date.now() >= end) return false;
      await sleep(stepMs);
    }
  }

  // ---- Innertube (the page's own API) ------------------------------------------

  async function sha1(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Same format the page builds for signed-in requests.
  async function authHeader() {
    const ts = Math.floor(Date.now() / 1000);
    const parts = [];
    for (const [name, value] of [
      ['SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID')],
      ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookie('__Secure-3PAPISID')]
    ]) {
      if (value) parts.push(`${name} ${ts}_${await sha1(`${ts} ${value} ${location.origin}`)}`);
    }
    return parts.join(' ') || null;
  }

  async function innertube(endpoint, body) {
    const context = cfg('INNERTUBE_CONTEXT');
    if (!context) throw new Error('YouTube Music page is not ready (no INNERTUBE_CONTEXT). Reload the tab.');
    const headers = {
      'content-type': 'application/json',
      'x-origin': location.origin,
      'x-youtube-client-name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 67),
      'x-youtube-client-version': String(cfg('INNERTUBE_CLIENT_VERSION') || context.client.clientVersion || '')
    };
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['x-goog-visitor-id'] = visitor;
    if (cfg('LOGGED_IN')) {
      const auth = await authHeader();
      if (auth) headers.authorization = auth;
      headers['x-goog-authuser'] = String(cfg('SESSION_INDEX') || 0);
      const pageId = cfg('DELEGATED_SESSION_ID');
      if (pageId) headers['x-goog-pageid'] = String(pageId);
    }
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, ...body })
    });
    if (!res.ok) throw new Error(`YouTube Music ${endpoint} returned HTTP ${res.status}`);
    return res.json();
  }

  // ---- Search -------------------------------------------------------------------

  let songsParams = null; // the "Songs" chip's filter value, learned from the first unfiltered search

  const TYPE_SCORE = {
    MUSIC_VIDEO_TYPE_ATV: 0.1,  // the studio song
    MUSIC_VIDEO_TYPE_OMV: 0.04, // official music video
    MUSIC_VIDEO_TYPE_UGC: -0.08 // someone's upload
  };
  const VARIANT = /\b(live|remix|cover|karaoke|instrumental|acoustic|demo|sped up|slowed|8d|reverb|tribute)\b/;

  function cleanTitle(t) {
    return (t || '').replace(/\s*[([][^)\]]*(remaster|version|mono|stereo|edit|mix|deluxe|official|audio|video|lyric)[^)\]]*[)\]]/gi, '')
      .replace(/\s+-\s+.*(remaster|version|mono|stereo|edit).*$/i, '');
  }

  function tokens(s) { return norm(s).split(' ').filter(Boolean); }

  // Dice similarity on word tokens, with a boost when one side contains the other.
  function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    const common = A.filter((x) => setB.has(x)).length;
    const dice = (2 * common) / (A.length + B.length);
    const na = A.join(' '), nb = B.join(' ');
    return na === nb ? 1 : (na.includes(nb) || nb.includes(na)) ? Math.max(dice, 0.85) : dice;
  }

  function pageTypeOf(run) {
    return run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint &&
      run.navigationEndpoint.browseEndpoint.browseEndpointContextSupportedConfigs &&
      run.navigationEndpoint.browseEndpoint.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig &&
      run.navigationEndpoint.browseEndpoint.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType;
  }

  // Artist/album from subtitle runs: linked runs carry their page type; otherwise split on " • ".
  function parseByline(runs) {
    const out = { artists: [], album: '' };
    for (const r of runs || []) {
      const t = pageTypeOf(r);
      if (t === 'MUSIC_PAGE_TYPE_ARTIST' || t === 'MUSIC_PAGE_TYPE_USER_CHANNEL') out.artists.push(r.text);
      else if (t === 'MUSIC_PAGE_TYPE_ALBUM') out.album = r.text;
    }
    if (!out.artists.length) {
      const parts = (runs || []).map((r) => r.text).join('').split(' • ').map((s) => s.trim());
      const skip = /^(song|video|episode|single|ep|album)$/i;
      const first = parts.find((p) => p && !skip.test(p));
      if (first) out.artists.push(first);
    }
    return out;
  }

  function candidateFromListItem(r) {
    const cols = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text);
    const watch = collect(r.overlay, 'watchEndpoint')[0] || collect(cols[0], 'watchEndpoint')[0];
    const videoId = (r.playlistItemData && r.playlistItemData.videoId) || (watch && watch.videoId);
    if (!videoId) return null;
    const by = parseByline(cols[1] && cols[1].runs);
    return {
      videoId,
      title: runsText(cols[0]),
      artist: by.artists.join(', '),
      album: by.album,
      type: collect(r, 'musicVideoType')[0] || null
    };
  }

  function candidateFromCard(card) {
    const watch = collect(card.title, 'watchEndpoint')[0];
    if (!watch || !watch.videoId) return null;
    const by = parseByline(card.subtitle && card.subtitle.runs);
    return {
      videoId: watch.videoId, title: runsText(card.title), artist: by.artists.join(', '), album: by.album,
      type: (watch.watchEndpointMusicSupportedConfigs && watch.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig &&
        watch.watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType) || null
    };
  }

  function candidates(json) {
    const out = [];
    for (const card of collect(json, 'musicCardShelfRenderer')) {
      const c = candidateFromCard(card);
      if (c) out.push(c);
    }
    for (const r of collect(json, 'musicResponsiveListItemRenderer')) {
      const c = candidateFromListItem(r);
      if (c) out.push(c);
    }
    return out;
  }

  function learnSongsParams(json) {
    for (const c of collect(json, 'chipCloudChipRenderer')) {
      const params = c.navigationEndpoint && c.navigationEndpoint.searchEndpoint && c.navigationEndpoint.searchEndpoint.params;
      if (params && (c.uniqueId === 'Songs' || /^songs$/i.test(runsText(c.text)))) {
        songsParams = params;
        return;
      }
    }
  }

  function score(want, c) {
    const titleSim = similarity(cleanTitle(want.title), cleanTitle(c.title));
    const artistSim = Math.max(similarity(want.artist, c.artist), c.artist ? similarity(want.artist, c.artist.split(',')[0]) : 0);
    let s = titleSim * 0.6 + artistSim * 0.4 + (TYPE_SCORE[c.type] || 0);
    if (VARIANT.test(norm(c.title)) && !VARIANT.test(norm(want.title))) s -= 0.25;
    if (want.album && c.album && similarity(want.album, c.album) > 0.8) s += 0.05;
    return { s, titleSim, artistSim };
  }

  async function search({ title, artist, album }) {
    const want = { title, artist, album };
    const query = `${title} ${artist}`;
    let pool = [];
    if (!songsParams) {
      const json = await innertube('search', { query });
      learnSongsParams(json);
      pool = candidates(json);
    }
    if (songsParams) {
      try {
        pool = candidates(await innertube('search', { query, params: songsParams })).concat(pool);
      } catch {}
    }
    let best = null;
    for (const c of pool) {
      const sc = score(want, c);
      if (sc.titleSim < 0.6 || sc.artistSim < 0.5) continue;
      if (!best || sc.s > best.score) best = { ...c, score: Math.round(sc.s * 100) / 100 };
    }
    return best;
  }

  // ---- Queue ----------------------------------------------------------------------

  function queueRoot() {
    return document.querySelector('ytmusic-player-queue');
  }

  // Top-level rows as the user sees them. A wrapper row holds the song and video versions of one item.
  function queueRows() {
    const q = queueRoot();
    if (!q) return [];
    return [...q.querySelectorAll('ytmusic-player-queue-item, ytmusic-playlist-panel-video-wrapper-renderer')]
      .filter((el) => !el.parentElement.closest('ytmusic-playlist-panel-video-wrapper-renderer'));
  }

  function dataOf(el) {
    return el.data || el.__data || null;
  }

  // The renderer that represents the row (the primary version for wrappers).
  function primaryRenderer(d) {
    if (!d) return null;
    if (d.playlistPanelVideoRenderer) return d.playlistPanelVideoRenderer;
    if (d.primaryRenderer && d.primaryRenderer.playlistPanelVideoRenderer) return d.primaryRenderer.playlistPanelVideoRenderer;
    return d.videoId ? d : null;
  }

  function describeRow(d) {
    const primary = primaryRenderer(d);
    if (!primary) return null;
    const all = [primary, ...collect(d, 'playlistPanelVideoRenderer')];
    const videoIds = [...new Set(all.map((r) => r.videoId).filter(Boolean))];
    const longByline = (primary.longBylineText && primary.longBylineText.runs) || [];
    const yearRun = longByline.map((r) => r.text.trim()).reverse().find((t) => /^\d{4}$/.test(t));
    return {
      videoId: primary.videoId,
      videoIds,
      title: runsText(primary.title),
      artist: runsText(primary.shortBylineText),
      year: yearRun ? Number(yearRun) : null,
      selected: all.some((r) => r.selected)
    };
  }

  function rowItemElement(el) {
    return el.tagName.toLowerCase() === 'ytmusic-player-queue-item' ? el : (el.querySelector('ytmusic-player-queue-item') || el);
  }

  function readQueue() {
    const rows = queueRows();
    let items = rows.map((el) => describeRow(dataOf(el)));
    let source = 'dom';
    if (!rows.length || items.every((x) => !x)) {
      // Fallback: the queue element's own state.
      try {
        const st = queueRoot() && queueRoot().getState && queueRoot().getState();
        const arr = st && st.queue && Object.values(st.queue).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        if (arr) {
          items = arr.map((d) => describeRow(d));
          source = 'state';
        }
      } catch {}
    }
    items = items.map((x, i) => (x ? { ...x, index: i } : { index: i, videoId: null, videoIds: [], selected: false }));
    let selectedIndex = items.findIndex((x) => x.selected);
    if (selectedIndex < 0) {
      const current = currentVideoId();
      selectedIndex = current ? items.findIndex((x) => x.videoIds.includes(current)) : -1;
    }
    return { items, selectedIndex, rows: source === 'dom' ? rows : [], source };
  }

  function getQueue() {
    const { items, selectedIndex, source } = readQueue();
    return { items, selectedIndex, source };
  }

  // Count of rows after the current one that contain this video.
  function upcomingCount(id) {
    const { items, selectedIndex } = readQueue();
    return items.filter((x, i) => i > selectedIndex && x.videoIds.includes(id)).length;
  }

  // ---- Running queue commands --------------------------------------------------------
  //
  // YouTube Music's own "Play next" / "Remove from queue" menu entries run their command through the
  // menu item's ytmusicServiceMenuItemBehavior.handleCommand(), which calls the queue service directly
  // (POST /music/get_queue, then applies the returned commands). So that is the first route here.
  // Menu items only exist once a menu has been opened, so if there are none yet, one queue row's menu
  // is opened and closed again. Each route is checked against the real queue before trying the next,
  // and the route that worked is remembered.

  const MENU_BUTTON = 'ytmusic-menu-renderer yt-button-shape button, ytmusic-menu-renderer #button, ' +
    'ytmusic-menu-renderer tp-yt-paper-icon-button, ytmusic-menu-renderer button';

  function serviceRequest(el, endpoint) {
    el.dispatchEvent(new CustomEvent('yt-action', {
      bubbles: true, composed: true,
      detail: { actionName: 'yt-service-request', optionalAction: false, args: [el, endpoint], returnValue: [] }
    }));
  }

  function behaviorOf(el) {
    for (const holder of [el && el.inst, el && el.polymerController, el]) {
      const b = holder && holder.ytmusicServiceMenuItemBehavior;
      if (b && typeof b.handleCommand === 'function') return b;
    }
    return null;
  }

  function findMenuBehavior() {
    for (const el of document.querySelectorAll('ytmusic-menu-service-item-renderer, ytmusic-multi-select-menu-bar')) {
      const b = behaviorOf(el);
      if (b) return b;
    }
    return null;
  }

  function visibleMenuItems() {
    return [...document.querySelectorAll('ytmusic-menu-service-item-renderer')].filter((el) => el.offsetParent !== null);
  }

  function closeMenus() {
    for (const d of document.querySelectorAll('tp-yt-iron-dropdown')) {
      try { if (d.opened && typeof d.close === 'function') d.close(); } catch {}
    }
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, composed: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
  }

  async function openRowMenu(row) {
    const button = row && row.querySelector(MENU_BUTTON);
    if (!button) return false;
    button.click();
    return waitFor(() => visibleMenuItems().length > 0, 2500);
  }

  function anyRow() {
    const { rows, selectedIndex } = readQueue();
    return rows[selectedIndex] || rows[0] || null;
  }

  async function menuBehavior() {
    let b = findMenuBehavior();
    if (b) return b;
    if (await openRowMenu(anyRow())) b = findMenuBehavior();
    closeMenus();
    return b;
  }

  // Opens a row's menu and clicks the entry carrying `name`; for adds, the entry is pointed at our song first.
  async function clickMenuEntry(row, name, endpoint) {
    if (!(await openRowMenu(row))) { closeMenus(); return false; }
    const entry = visibleMenuItems().find((el) => {
      const d = dataOf(el);
      return d && d.serviceEndpoint && d.serviceEndpoint[name] &&
        (name !== 'queueAddEndpoint' || d.serviceEndpoint[name].queueInsertPosition === 'INSERT_AFTER_CURRENT_VIDEO');
    });
    if (!entry) { closeMenus(); return false; }
    if (endpoint) {
      for (const holder of [dataOf(entry), entry.inst && entry.inst.data]) {
        if (holder && typeof holder === 'object') holder.serviceEndpoint = endpoint;
      }
    }
    entry.click();
    await sleep(100);
    closeMenus();
    return true;
  }

  // Runs one route. Returns false if the route couldn't even be attempted.
  async function runRoute(route, endpoint, row) {
    const name = Object.keys(endpoint)[0];
    if (route === 'menu-behavior') {
      const b = await menuBehavior();
      if (!b) return false;
      try { await b.handleCommand(endpoint); } catch {}
      return true;
    }
    if (route === 'menu-click') {
      return clickMenuEntry(row || anyRow(), name, name === 'queueAddEndpoint' ? endpoint : null);
    }
    if (route === 'service-request') {
      const target = (row && rowItemElement(row)) || document.querySelector('ytmusic-app');
      if (!target) return false;
      serviceRequest(target, endpoint);
      return true;
    }
    return false;
  }

  const ROUTES = ['menu-behavior', 'menu-click', 'service-request'];
  const working = { add: null, remove: null };

  // Tries routes until `done()` holds. Waits long enough per route that a slow network can't cause a duplicate.
  async function runQueueCommand(kind, endpoint, done, row = null) {
    const order = working[kind] ? [working[kind], ...ROUTES.filter((r) => r !== working[kind])] : ROUTES;
    const attempts = [];
    for (const route of order) {
      let ran = false;
      let error = null;
      try { ran = await runRoute(route, endpoint, row); } catch (err) { error = String((err && err.message) || err); }
      const ok = ran && ((await waitFor(done, 4000)) || (await waitFor(done, 3000)));
      attempts.push({ route, ran, ok, error });
      if (ok) { working[kind] = route; return { ok: true, attempts }; }
    }
    return { ok: false, attempts };
  }

  function diagnostics(attempts) {
    const q = readQueue();
    return {
      attempts,
      queue: { rows: q.rows.length, items: q.items.length, selectedIndex: q.selectedIndex, source: q.source },
      menuItemsInPage: document.querySelectorAll('ytmusic-menu-service-item-renderer').length,
      menuBehaviorFound: !!findMenuBehavior(),
      rowHasMenuButton: !!(anyRow() && anyRow().querySelector(MENU_BUTTON)),
      clientVersion: cfg('INNERTUBE_CLIENT_VERSION') || null
    };
  }

  function playNextEndpoint(videoId) {
    return {
      queueAddEndpoint: {
        queueTarget: { videoId, onEmptyQueue: { watchEndpoint: { videoId } } },
        queueInsertPosition: 'INSERT_AFTER_CURRENT_VIDEO'
      }
    };
  }

  // Inserts the songs right after the current one, in the given order (so it inserts back to front).
  async function playNext({ videoIds }) {
    const results = [];
    let diag = null;
    for (const id of [...videoIds].reverse()) {
      // If no route works for a song, the rest won't fare better: report them without trying.
      if (diag) { results.unshift({ videoId: id, ok: false }); continue; }
      const before = upcomingCount(id);
      const r = await runQueueCommand('add', playNextEndpoint(id), () => upcomingCount(id) > before);
      if (!r.ok) diag = diagnostics(r.attempts);
      results.unshift({ videoId: id, ok: r.ok, route: r.ok ? working.add : null });
      if (r.ok) await sleep(150);
    }
    return { results, diagnostics: diag };
  }

  function menuEndpoint(renderer, name) {
    const items = (renderer && renderer.menu && renderer.menu.menuRenderer && renderer.menu.menuRenderer.items) || [];
    for (const it of items) {
      const r = it[Object.keys(it)[0]];
      if (r && r.serviceEndpoint && r.serviceEndpoint[name]) return r.serviceEndpoint;
    }
    return null;
  }

  // Removes the first upcoming occurrence of each video.
  async function remove({ videoIds }) {
    const results = [];
    let diag = null;
    for (const id of videoIds) {
      if (diag) { results.push({ videoId: id, ok: false }); continue; }
      const { items, selectedIndex, rows } = readQueue();
      const idx = items.findIndex((x, i) => i > selectedIndex && x.videoIds.includes(id));
      if (idx < 0) { results.push({ videoId: id, ok: true, already: true }); continue; }
      const row = rows[idx];
      const ep = row && (menuEndpoint(primaryRenderer(dataOf(row)), 'removeFromQueueEndpoint') ||
        menuEndpoint(primaryRenderer(dataOf(rowItemElement(row))), 'removeFromQueueEndpoint'));
      if (!ep) { results.push({ videoId: id, ok: false }); continue; }
      const before = upcomingCount(id);
      const r = await runQueueCommand('remove', { removeFromQueueEndpoint: ep.removeFromQueueEndpoint }, () => upcomingCount(id) < before, row);
      if (!r.ok && !diag) diag = diagnostics(r.attempts);
      results.push({ videoId: id, ok: r.ok });
    }
    return { results, diagnostics: diag };
  }

  // ---- Library (for the discovery slider) ---------------------------------------------

  async function libraryArtists() {
    if (!cfg('LOGGED_IN')) return { artists: [], loggedIn: false };
    const names = new Map();
    const add = (n) => { const k = norm(n); if (k && !names.has(k)) names.set(k, n.trim()); };
    for (const browseId of ['FEmusic_library_corpus_track_artists', 'FEmusic_library_corpus_artists']) {
      try {
        const json = await innertube('browse', { browseId });
        for (const r of collect(json, 'musicResponsiveListItemRenderer')) {
          const col = r.flexColumns && r.flexColumns[0] && r.flexColumns[0].musicResponsiveListItemFlexColumnRenderer;
          add(runsText(col && col.text));
        }
      } catch {}
    }
    try {
      const json = await innertube('browse', { browseId: 'FEmusic_liked_videos' });
      for (const r of collect(json, 'musicResponsiveListItemRenderer')) {
        const c = candidateFromListItem(r);
        if (c && c.artist) c.artist.split(', ').forEach(add);
      }
    } catch {}
    return { artists: [...names.values()].slice(0, 400), loggedIn: true };
  }

  // ---- Now playing ----------------------------------------------------------------------

  function currentVideoId() {
    const player = document.getElementById('movie_player');
    try {
      const id = player && player.getVideoData && player.getVideoData().video_id;
      if (id) return id;
    } catch {}
    return new URLSearchParams(location.search).get('v') || null;
  }

  function isAdPlaying() {
    const player = document.getElementById('movie_player');
    return !!(player && player.classList.contains('ad-showing'));
  }

  function isPlaying() {
    const video = document.querySelector('video');
    if (video) return !video.paused && !video.ended;
    return navigator.mediaSession && navigator.mediaSession.playbackState === 'playing';
  }

  // The player bar's tag has changed before (ytmusic-player-bar is gone in late-2026 builds), so find it by
  // tag pattern and cache it.
  let playerBar = null;
  function findPlayerBar() {
    if (playerBar && playerBar.isConnected) return playerBar;
    playerBar = document.querySelector('ytmusic-player-bar');
    if (!playerBar) {
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/^ytmusic-.*player-bar/.test(n.tagName.toLowerCase())) { playerBar = n; break; }
      }
    }
    return playerBar;
  }

  function playerBarInfo() {
    const bar = findPlayerBar();
    if (!bar) return { title: '', artist: '', album: '', year: null };
    const t = (sel) => { const el = bar.querySelector(sel); return el ? (el.getAttribute('title') || el.textContent || '').trim() : ''; };
    const parts = t('.byline').split('•').map((s) => s.trim()).filter(Boolean);
    let year = null;
    if (parts.length && /^\d{4}$/.test(parts[parts.length - 1])) year = Number(parts.pop());
    return { title: t('.title'), artist: parts[0] || '', album: parts[1] || '', year };
  }

  let yearCache = { id: null, year: null };
  function yearFor(id, barYear) {
    if (barYear) return barYear;
    if (yearCache.id === id) return yearCache.year;
    let year = null;
    try {
      const { items, selectedIndex } = readQueue();
      const cur = items[selectedIndex];
      if (cur && cur.videoIds.includes(id)) year = cur.year;
    } catch {}
    yearCache = { id, year };
    return year;
  }

  function getNowPlaying() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const bar = (md && md.title && md.artist) ? null : playerBarInfo();
    const title = (md && md.title) || (bar && bar.title);
    if (!title) return null;
    let artwork = '';
    if (md && md.artwork && md.artwork.length) artwork = md.artwork[md.artwork.length - 1].src;
    const video = document.querySelector('video');
    const videoId = currentVideoId();
    return {
      videoId,
      title,
      artist: (md && md.artist) || (bar && bar.artist) || '',
      album: (md && md.album) || (bar && bar.album) || '',
      year: yearFor(videoId, bar && bar.year),
      artwork,
      playing: isPlaying(),
      position: video ? Math.floor(video.currentTime) : null,
      duration: video && isFinite(video.duration) ? Math.floor(video.duration) : null
    };
  }

  // ---- Change detection + "played" accounting ----------------------------------------------

  let lastKey = '';
  let lastPlaying = null;
  let lastSent = 0;
  let playedSeconds = 0;
  let reportedPlayed = false;

  let lastTrack = null;

  function tick() {
    if (isAdPlaying()) {
      // Keep the connection alive through ads, reporting the last real track.
      if (lastTrack && Date.now() - lastSent >= HEARTBEAT_MS) {
        lastSent = Date.now();
        post('nowPlaying', lastTrack);
      }
      return;
    }
    const track = getNowPlaying();
    if (!track) return;
    lastTrack = track;

    const key = track.videoId || `${track.title}\u0000${track.artist}`;
    const now = Date.now();

    if (key !== lastKey) {
      lastKey = key;
      playedSeconds = 0;
      reportedPlayed = false;
      lastPlaying = track.playing;
      lastSent = now;
      post('nowPlaying', track);
      return;
    }

    if (track.playing) playedSeconds += POLL_MS / 1000;
    if (!reportedPlayed && playedSeconds >= PLAYED_AFTER_S) {
      reportedPlayed = true;
      post('trackPlayed', track);
    }

    if (track.playing !== lastPlaying || now - lastSent >= HEARTBEAT_MS) {
      lastPlaying = track.playing;
      lastSent = now;
      post('nowPlaying', track);
    }
  }

  setInterval(tick, POLL_MS);
  tick();

  // ---- Requests from the extension --------------------------------------------------------

  const OPS = { search, getQueue, playNext, remove, libraryArtists };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== EXT || typeof msg.id !== 'string') return;
    const op = OPS[msg.op];
    let reply;
    try {
      if (!op) throw new Error(`Unknown operation ${msg.op}`);
      reply = { ok: true, result: await op(msg.args || {}) };
    } catch (err) {
      reply = { ok: false, error: (err && err.message) || String(err) };
    }
    window.postMessage({ source: PAGE, type: 'rpcResult', id: msg.id, ...reply }, location.origin);
  });
})();
