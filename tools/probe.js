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

  function describeQueueItem(el) {
    const d = el.data || el.__data || null;
    const inner = d && (d.playlistPanelVideoRenderer || d.primaryRenderer && d.primaryRenderer.playlistPanelVideoRenderer || d);
    const menuItems = inner && inner.menu && inner.menu.menuRenderer && inner.menu.menuRenderer.items || [];
    return {
      tag: el.tagName.toLowerCase(),
      dataKeys: keys(d),
      videoId: inner && inner.videoId,
      title: cut(runsText(inner && inner.title), 60),
      selected: !!(inner && inner.selected) || el.hasAttribute('selected'),
      menu: menuItems.map((it) => {
        const type = Object.keys(it)[0];
        const ep = it[type] && it[type].serviceEndpoint;
        const epType = ep && Object.keys(ep).find((k) => k.endsWith('Endpoint') || k.endsWith('Command'));
        const entry = { type, text: cut(runsText(it[type] && it[type].text), 40), endpoint: epType || null };
        if (epType === 'removeFromQueueEndpoint') entry.removeFromQueueEndpoint = ep[epType];
        return entry;
      })
    };
  }

  function queueItems() {
    return [...document.querySelectorAll('ytmusic-player-queue ytmusic-player-queue-item, ytmusic-player-queue ytmusic-playlist-panel-video-wrapper-renderer')]
      .filter((el) => !el.parentElement || !el.parentElement.closest('ytmusic-player-queue-item'));
  }

  function serviceRequest(el, endpoint) {
    el.dispatchEvent(new CustomEvent('yt-action', {
      bubbles: true, composed: true,
      detail: { actionName: 'yt-service-request', optionalAction: false, args: [el, endpoint], returnValue: [] }
    }));
  }

  async function run({ write = false } = {}) {
    const report = { probeVersion: 2, at: new Date().toISOString(), write };
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

    await step('queueElement', () => {
      const q = document.querySelector('ytmusic-player-queue');
      if (!q) return null;
      const out = { ownKeys: Object.keys(q).filter((k) => !k.startsWith('__')).slice(0, 40) };
      for (const k of ['store', 'queue', 'queueStore', 'data']) out['has_' + k] = q[k] != null;
      try {
        const st = q.store && q.store.getState && q.store.getState();
        if (st) {
          out.storeKeys = keys(st);
          out.queueStateKeys = keys(st.queue);
          out.queueStateItems = st.queue && Array.isArray(st.queue.items) ? st.queue.items.length : null;
        }
      } catch (err) { out.storeError = String(err); }
      return out;
    });

    await step('queueItems', () => {
      const items = queueItems();
      const sel = items.findIndex((el) => describeQueueItem(el).selected);
      return {
        count: items.length,
        selectedIndex: sel,
        sample: items.slice(Math.max(0, sel), Math.max(0, sel) + 3).map(describeQueueItem)
      };
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
        const target = document.querySelector('ytmusic-player-bar') || document.querySelector('ytmusic-app');
        const before = queueItems().length;
        serviceRequest(target, {
          queueAddEndpoint: {
            queueTarget: { videoId: pick.videoId, onEmptyQueue: { watchEndpoint: { videoId: pick.videoId } } },
            queueInsertPosition: 'INSERT_AFTER_CURRENT_VIDEO'
          }
        });
        await sleep(2500);
        const items = queueItems();
        const described = items.map(describeQueueItem);
        const sel = described.findIndex((d) => d.selected);
        const at = described.findIndex((d, i) => i > sel && d.videoId === pick.videoId);
        const result = { dispatchedOn: target.tagName.toLowerCase(), song: pick, countBefore: before, countAfter: items.length, selectedIndex: sel, insertedAt: at };
        if (at >= 0) {
          result.insertedItem = described[at];
          const ep = described[at].menu.find((m) => m.endpoint === 'removeFromQueueEndpoint');
          if (ep) {
            serviceRequest(items[at], { removeFromQueueEndpoint: ep.removeFromQueueEndpoint });
            await sleep(2000);
            result.removedOk = !queueItems().map(describeQueueItem).some((d, i) => i > sel && d.videoId === pick.videoId);
          } else {
            result.removedOk = false;
            result.note = 'no removeFromQueueEndpoint in the item menu data; remove the test song by hand';
          }
        }
        return result;
      });
    }

    const text = JSON.stringify(report, null, 1);
    console.log('%cMusic Steer probe report (copy everything below):', 'font-weight:bold');
    console.log(text);
    try { copy(text); console.log('%cReport copied to clipboard.', 'color:green'); } catch {}
    return report;
  }

  window.musicSteerProbe = run;
  run();
})();
