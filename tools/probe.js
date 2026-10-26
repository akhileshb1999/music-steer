// Music Steer probe: paste into the DevTools console on music.youtube.com.
//
// It checks, in your logged-in session, the YouTube Music internals the queue code will rely on,
// and prints a JSON report to paste back. It never prints cookie values.
//
// Step 1 runs automatically and is read-only.
// Step 2 is opt-in: `await musicSteerProbe({ write: true })` adds one song with "Play next",
// checks where it landed, then removes it again.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cut = (s, n = 80) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 30) : null);
  const runsText = (t) => (t && (t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';

  function cfg(name) {
    try { return window.ytcfg && window.ytcfg.get(name); } catch { return undefined; }
  }

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function sha1(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Same format the page builds: "SAPISIDHASH <ts>_<sha1(ts SAPISID origin)>" (+ 1P/3P variants).
  async function authHeader() {
    const ts = Math.floor(Date.now() / 1000);
    const parts = [];
    const variants = [
      ['SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID')],
      ['SAPISID1PHASH', cookie('__Secure-1PAPISID')],
      ['SAPISID3PHASH', cookie('__Secure-3PAPISID')]
    ];
    for (const [name, value] of variants) {
      if (value) parts.push(`${name} ${ts}_${await sha1(`${ts} ${value} ${location.origin}`)}`);
    }
    return parts.join(' ') || null;
  }

  async function innertube(endpoint, body, { auth = false } = {}) {
    const headers = {
      'content-type': 'application/json',
      'x-origin': location.origin,
      'x-youtube-client-name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 67),
      'x-youtube-client-version': String(cfg('INNERTUBE_CLIENT_VERSION') || '')
    };
    const visitor = cfg('VISITOR_DATA');
    if (visitor) headers['x-goog-visitor-id'] = visitor;
    if (auth) {
      const a = await authHeader();
      if (a) headers.authorization = a;
      headers['x-goog-authuser'] = String(cfg('SESSION_INDEX') || 0);
    }
    const res = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ context: cfg('INNERTUBE_CONTEXT'), ...body })
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }

  // Collects every object under `key` anywhere in a response (robust to layout shuffles).
  function collect(node, key, out = [], depth = 0) {
    if (!node || typeof node !== 'object' || depth > 40) return out;
    if (Array.isArray(node)) { for (const x of node) collect(x, key, out, depth + 1); return out; }
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      else collect(v, key, out, depth + 1);
    }
    return out;
  }

  function parseListItem(r) {
    const cols = (r.flexColumns || []).map((c) => runsText(c.musicResponsiveListItemFlexColumnRenderer && c.musicResponsiveListItemFlexColumnRenderer.text));
    const watch = collect(r.overlay, 'watchEndpoint')[0];
    return {
      videoId: (r.playlistItemData && r.playlistItemData.videoId) || (watch && watch.videoId) || null,
      type: collect(r, 'musicVideoType')[0] || null, // ATV = song, OMV = official video, UGC = upload
      cols: cols.map((c) => cut(c, 100))
    };
  }

  function itemData(el) {
    const d = el.data || el.__data || null;
    return d && (d.playlistPanelVideoRenderer || (d.primaryRenderer && d.primaryRenderer.playlistPanelVideoRenderer) || d);
  }

  function menuEndpoint(inner, name) {
    const items = (inner && inner.menu && inner.menu.menuRenderer && inner.menu.menuRenderer.items) || [];
    for (const it of items) {
      const r = it[Object.keys(it)[0]];
      const ep = r && r.serviceEndpoint && r.serviceEndpoint[name];
      if (ep) return { text: runsText(r.text), ep };
    }
    return null;
  }

  // Compact: one line per item, menu reduced to the two entries the extension cares about.
  function describeQueueItem(el) {
    const inner = itemData(el);
    const remove = menuEndpoint(inner, 'removeFromQueueEndpoint');
    return {
      tag: el.tagName.toLowerCase().replace('ytmusic-', ''),
      videoId: inner && inner.videoId,
      title: cut(runsText(inner && inner.title), 40),
      selected: !!(inner && inner.selected) || el.hasAttribute('selected'),
      hasPlayNext: !!menuEndpoint(inner, 'queueAddEndpoint'),
      remove: remove ? { videoId: remove.ep.videoId, itemId: remove.ep.itemId } : null
    };
  }

  // The queue as the user sees it: top-level rows only (a wrapper holds the song + video versions).
  function queueItems() {
    const q = document.querySelector('ytmusic-player-queue');
    if (!q) return [];
    return [...q.querySelectorAll('ytmusic-player-queue-item, ytmusic-playlist-panel-video-wrapper-renderer')]
      .filter((el) => !el.parentElement.closest('ytmusic-playlist-panel-video-wrapper-renderer'));
  }

  // The element to act on for a row: the primary inner item for wrappers.
  function rowItem(el) {
    return el.tagName.toLowerCase() === 'ytmusic-player-queue-item' ? el : (el.querySelector('ytmusic-player-queue-item') || el);
  }

  function serviceRequest(el, endpoint) {
    el.dispatchEvent(new CustomEvent('yt-action', {
      bubbles: true, composed: true,
      detail: { actionName: 'yt-service-request', optionalAction: false, args: [el, endpoint], returnValue: [] }
    }));
  }

  async function run({ write = false } = {}) {
    const report = { probeVersion: 3, at: new Date().toISOString(), write };
    const step = async (name, fn) => {
      try { report[name] = await fn(); } catch (err) { report[name] = { error: String(err && err.stack || err) }; }
    };

    await step('env', () => ({
      url: location.pathname + location.search.slice(0, 30),
      hasYtcfg: !!window.ytcfg,
      clientName: cfg('INNERTUBE_CONTEXT') && cfg('INNERTUBE_CONTEXT').client && cfg('INNERTUBE_CONTEXT').client.clientName,
      clientVersion: cfg('INNERTUBE_CLIENT_VERSION'),
      hasApiKey: !!cfg('INNERTUBE_API_KEY'),
      loggedIn: cfg('LOGGED_IN'),
      sessionIndex: cfg('SESSION_INDEX'),
      cookies: {
        SAPISID: !!cookie('SAPISID'), '__Secure-1PAPISID': !!cookie('__Secure-1PAPISID'), '__Secure-3PAPISID': !!cookie('__Secure-3PAPISID')
      },
      elements: Object.fromEntries(['ytmusic-app', 'ytmusic-player-bar', 'ytmusic-player-queue', 'ytmusic-player-page', '#movie_player']
        .map((s) => [s, !!document.querySelector(s)]))
    }));

    await step('nowPlaying', () => {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      let vd = null;
      try { vd = document.getElementById('movie_player').getVideoData(); } catch {}
      return { mediaSession: md ? { title: md.title, artist: md.artist, album: md.album } : null, videoData: vd && { video_id: vd.video_id, title: vd.title, author: vd.author } };
    });

    await step('queueState', () => {
      const q = document.querySelector('ytmusic-player-queue');
      if (!q || typeof q.getState !== 'function') return { hasGetState: false };
      const st = q.getState();
      const qs = st && st.queue;
      const out = { stateKeys: keys(st), queueKeys: keys(qs) };
      if (qs) {
        for (const [k, v] of Object.entries(qs)) {
          if (Array.isArray(v)) out['len_' + k] = v.length;
          else if (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length < 40)) out['val_' + k] = v;
        }
        const arr = Object.values(qs).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        if (arr) {
          out.firstItemKeys = keys(arr[0]);
          const r = itemData({ data: arr[0] }) || {};
          out.firstItemVideoId = r.videoId || null;
          out.firstItemInnerKeys = keys(r);
        }
      }
      out.elementQueueKeys = keys(q.queue);
      return out;
    });

    await step('queueItems', () => {
      const rows = queueItems();
      const all = document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item').length;
      const wrappers = document.querySelectorAll('ytmusic-player-queue ytmusic-playlist-panel-video-wrapper-renderer');
      const described = rows.map((el) => describeQueueItem(rowItem(el)));
      const sel = described.findIndex((d) => d.selected);
      return {
        rows: rows.length, innerItems: all, wrappers: wrappers.length,
        itemsPerWrapper: [...new Set([...wrappers].map((w) => w.querySelectorAll('ytmusic-player-queue-item').length))],
        selectedIndex: sel,
        next: described.slice(Math.max(0, sel), Math.max(0, sel) + 3)
      };
    });

    await step('playerBar', () => {
      // Custom-element ancestors of a node, e.g. "ytmusic-app > ytmusic-player-bar".
      const chain = (el) => {
        const out = [];
        for (let e = el.parentElement; e && out.length < 4; e = e.parentElement) {
          const t = e.tagName.toLowerCase();
          if (t.includes('-')) out.unshift(t);
        }
        return out.join(' > ');
      };
      const tags = [...new Set([...document.querySelectorAll('*')].map((e) => e.tagName.toLowerCase())
        .filter((t) => /player-bar|playerbar|mini-player|now-playing/.test(t)))];
      const bylines = [...document.querySelectorAll('.byline, [class*="byline"], .subtitle')]
        .map((e) => ({ chain: chain(e), cls: cut(String(e.className), 40), text: cut((e.textContent || '').trim().replace(/\s+/g, ' '), 80) }))
        .filter((b) => b.text && /player/.test(b.chain + ' ' + b.cls)).slice(0, 4);
      return { tags, bylines };
    });

    // The "Songs" filter value comes from the chips on an unfiltered search, not a hard-coded string.
    let songsParams = null;
    await step('searchAll', async () => {
      const { status, json } = await innertube('search', { query: 'Pink Floyd Echoes' });
      const items = collect(json, 'musicResponsiveListItemRenderer');
      const chips = collect(json, 'chipCloudChipRenderer').map((c) => ({
        text: runsText(c.text), id: c.uniqueId || null,
        params: (c.navigationEndpoint && c.navigationEndpoint.searchEndpoint && c.navigationEndpoint.searchEndpoint.params) || null
      }));
      const songs = chips.find((c) => c.id === 'Songs') || chips.find((c) => /^songs$/i.test(c.text));
      songsParams = songs ? songs.params : null;
      const card = collect(json, 'musicCardShelfRenderer')[0];
      return {
        status, found: items.length, chips,
        topResult: card ? { title: runsText(card.title), subtitle: cut(runsText(card.subtitle), 80), videoId: (collect(card.title, 'watchEndpoint')[0] || {}).videoId || null } : null,
        first: items.slice(0, 4).map(parseListItem)
      };
    });

    await step('searchSongs', async () => {
      if (!songsParams) return { skipped: 'no Songs chip found' };
      const { status, json } = await innertube('search', { query: 'Pink Floyd Echoes', params: songsParams });
      const items = collect(json, 'musicResponsiveListItemRenderer');
      return { status, params: songsParams, found: items.length, first: items.slice(0, 3).map(parseListItem) };
    });

    await step('libraryArtists', async () => {
      const { status, json } = await innertube('browse', { browseId: 'FEmusic_library_corpus_track_artists' }, { auth: true });
      const items = collect(json, 'musicResponsiveListItemRenderer');
      return { status, found: items.length, first: items.slice(0, 5).map((r) => parseListItem(r).cols[0]), hasContinuation: collect(json, 'continuations').length > 0 || collect(json, 'continuationItemRenderer').length > 0 };
    });

    await step('likedSongs', async () => {
      const { status, json } = await innertube('browse', { browseId: 'FEmusic_liked_videos' }, { auth: true });
      const items = collect(json, 'musicResponsiveListItemRenderer');
      return { status, found: items.length, first: items.slice(0, 3).map((r) => parseListItem(r).cols.slice(0, 2)) };
    });

    if (write) {
      await step('playNext', async () => {
        const { json } = await innertube('search', { query: 'Fleetwood Mac Dreams', ...(songsParams ? { params: songsParams } : {}) });
        const pick = collect(json, 'musicResponsiveListItemRenderer').map(parseListItem).find((x) => x.videoId);
        if (!pick) return { error: 'no search result to test with' };
        const findIt = () => {
          const rows = queueItems().map(rowItem);
          const described = rows.map(describeQueueItem);
          const sel = described.findIndex((d) => d.selected);
          const at = described.findIndex((d, i) => i > sel && d.videoId === pick.videoId);
          return { rows, described, sel, at };
        };
        const result = { song: { videoId: pick.videoId, type: pick.type, cols: pick.cols.slice(0, 2) }, before: queueItems().length, tries: [] };
        const endpoint = {
          queueAddEndpoint: {
            queueTarget: { videoId: pick.videoId, onEmptyQueue: { watchEndpoint: { videoId: pick.videoId } } },
            queueInsertPosition: 'INSERT_AFTER_CURRENT_VIDEO'
          }
        };
        // Try the app root first, then the queue element (either should reach the app's action router).
        let found = findIt();
        for (const sel of ['ytmusic-app', 'ytmusic-player-queue']) {
          const target = document.querySelector(sel);
          if (!target || found.at >= 0) continue;
          serviceRequest(target, endpoint);
          await sleep(2500);
          found = findIt();
          result.tries.push({ on: sel, insertedAt: found.at, selectedIndex: found.sel, after: found.rows.length });
        }
        if (found.at < 0) return result;
        result.inserted = found.described[found.at];
        result.rightAfterCurrent = found.at === found.sel + 1;
        const remove = menuEndpoint(itemData(found.rows[found.at]), 'removeFromQueueEndpoint');
        if (!remove) {
          result.removedOk = false;
          result.note = 'no removeFromQueueEndpoint on the new item; remove the test song by hand';
          return result;
        }
        serviceRequest(found.rows[found.at], { removeFromQueueEndpoint: remove.ep });
        await sleep(2000);
        result.removedOk = findIt().at < 0;
        if (!result.removedOk) result.note = 'remove did not take effect; remove the test song by hand';
        return result;
      });
    }

    const text = JSON.stringify(report);
    console.log('%cMusic Steer probe report (copy everything below):', 'font-weight:bold');
    console.log(text);
    try {
      copy(text);
      console.log('%cReport copied to clipboard. Paste it straight into the chat (Ctrl+V / Cmd+V).', 'color:green');
    } catch {}
    return report;
  }

  window.musicSteerProbe = run;
  run();
})();
