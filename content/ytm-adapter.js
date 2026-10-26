// MAIN-world script on music.youtube.com.
//
// Every piece of code that depends on how YouTube Music's page works lives in this file,
// so when YouTube changes something this is the only place to fix.
//
// Phase 1: reads the now-playing track and reports it (via bridge.js) to the extension.
(() => {
  if (window.__musicSteerAdapter) return;
  window.__musicSteerAdapter = true;

  const SOURCE = 'music-steer:page';
  const POLL_MS = 1000;
  const HEARTBEAT_MS = 10000;
  const PLAYED_AFTER_S = 30; // seconds of actual playback before a song counts as "played"

  function post(type, track) {
    window.postMessage({ source: SOURCE, type, track }, location.origin);
  }

  // ---- Now playing -------------------------------------------------------

  function text(sel) {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute('title') || el.textContent || '').trim() : '';
  }

  function getVideoId() {
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

  // Player-bar byline reads like "Pink Floyd • The Dark Side of the Moon • 1973".
  function parseByline() {
    const parts = text('ytmusic-player-bar .byline').split('•').map((s) => s.trim()).filter(Boolean);
    const out = { artist: '', album: '', year: null };
    if (!parts.length) return out;
    const last = parts[parts.length - 1];
    if (/^\d{4}$/.test(last)) {
      out.year = Number(last);
      parts.pop();
    }
    out.artist = parts[0] || '';
    out.album = parts.length > 1 ? parts[1] : '';
    return out;
  }

  function getNowPlaying() {
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const byline = parseByline();
    const title = (md && md.title) || text('ytmusic-player-bar .title');
    if (!title) return null;
    let artwork = '';
    if (md && md.artwork && md.artwork.length) artwork = md.artwork[md.artwork.length - 1].src;
    const video = document.querySelector('video');
    return {
      videoId: getVideoId(),
      title,
      artist: (md && md.artist) || byline.artist,
      album: (md && md.album) || byline.album,
      year: byline.year,
      artwork,
      playing: isPlaying(),
      position: video ? Math.floor(video.currentTime) : null,
      duration: video && isFinite(video.duration) ? Math.floor(video.duration) : null
    };
  }

  // ---- Change detection + "played" accounting -----------------------------

  let lastKey = '';
  let lastPlaying = null;
  let lastSent = 0;
  let playedSeconds = 0;
  let reportedPlayed = false;

  function tick() {
    if (isAdPlaying()) return;
    const track = getNowPlaying();
    if (!track) return;

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
})();
