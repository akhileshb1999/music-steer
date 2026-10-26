// Pure functions (no chrome.* calls) that turn controls + listening context into a request,
// and clean up what comes back. Kept separate so they can be tested in Node.

import { norm } from './state.js';

export const HISTORY_IN_PROMPT = 20;
const KNOWN_ARTISTS_MAX = 150;

export const SYSTEM_PROMPT = `You are the DJ for one person's YouTube Music listening session. They steer with the controls below; you choose the next songs.

How to read the request:
- genres: target share of the picks for each genre (e.g. 70% hard rock, 30% blues rock means roughly 7 in 10 picks lean hard rock). Empty means follow the vibe of now_playing and recent_history.
- exclude_genres and avoid_artists are hard rules. Never pick a song whose main genre is excluded, or any song by an avoided artist (including features).
- Sliders run 0-100 and 50 means no preference. energy: 0 calm, 100 intense. heaviness: 0 soft, 100 heavy. tempo: 0 slow, 100 fast. popularity: 0 well-known hits, 100 deep cuts and album tracks. discovery: 0 only artists in known_artists or seed_artists, 100 only artists the listener does not know yet (not in known_artists). The further from 50, the stronger the preference.
- era: only songs originally released in that range of years. null means any era.
- seed_artists: steer toward these artists and artists like them. A note says which side of an artist's work they want; follow it closely.
- albums: "pull" means pick tracks from that album; "reference" means match that album's sound without necessarily picking from it.
- steer: plain-English direction from the listener. It refines everything above. If it describes a change over a number of songs, use songs_played_since_set to judge how far along that change should be now.

Rules for the picks:
- Pick real, released recordings that are likely available on YouTube Music. Give the song title and main artist as officially credited, without tags like "Remastered" or "Live" unless the listener asked for them.
- Never pick a song that is now_playing, in recent_history, in already_queued or in disliked.
- Order the picks so they flow naturally from now_playing.
- At most 2 songs by the same artist per batch. Don't follow now_playing with the same artist unless the controls call for it.
- reason: one short line (under 15 words) saying why this song fits the controls right now.
- Return exactly the number of songs requested.`;

export const PICKS_SCHEMA = {
  type: 'object',
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          artist: { type: 'string' },
          album: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['title', 'artist', 'album', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['songs'],
  additionalProperties: false
};

const SLIDER_SCALES = {
  energy: '0 calm .. 100 intense',
  heaviness: '0 soft .. 100 heavy',
  tempo: '0 slow .. 100 fast',
  popularity: '0 well-known hits .. 100 deep cuts',
  discovery: '0 artists I know .. 100 new to me'
};

const brief = (t) => ({ title: t.title, artist: t.artist });

// Songs (from newest-first history) played since a timestamp.
export function songsPlayedSince(history, since) {
  if (!since) return null;
  return history.filter((t) => t.playedAt > since).length;
}

export function knownArtists(history, controls) {
  const seen = new Map();
  const add = (name) => {
    const k = norm(name);
    if (k && !seen.has(k)) seen.set(k, name);
  };
  for (const a of controls.seedArtists || []) add(a.name);
  for (const t of history) add(t.artist);
  return [...seen.values()].slice(0, KNOWN_ARTISTS_MAX);
}

export function buildPayload({ controls, nowPlaying, history, queued = [], disliked = [], count }) {
  const total = controls.genres.reduce((s, g) => s + g.weight, 0);
  const sliders = {};
  for (const [key, scale] of Object.entries(SLIDER_SCALES)) sliders[key] = { value: controls[key], scale };

  const era = controls.eraFrom == null && controls.eraTo == null ? null : {
    from: controls.eraFrom ?? null,
    to: controls.eraTo == null ? null : controls.eraTo + 9
  };

  return {
    count,
    now_playing: nowPlaying ? {
      title: nowPlaying.title, artist: nowPlaying.artist,
      album: nowPlaying.album || undefined, year: nowPlaying.year || undefined
    } : null,
    recent_history: history.slice(0, HISTORY_IN_PROMPT).map(brief),
    already_queued: queued.map(brief),
    disliked: disliked.map((d) => ({ ...brief(d), reason: d.reason || undefined })),
    known_artists: knownArtists(history, controls),
    controls: {
      genres: controls.genres.map((g) => ({
        name: g.name, share: `${total ? Math.round((g.weight / total) * 100) : 0}%`
      })),
      exclude_genres: controls.excludeGenres,
      ...sliders,
      era,
      seed_artists: controls.seedArtists.map((a) => ({ name: a.name, note: a.note || undefined })),
      avoid_artists: controls.avoidArtists,
      albums: controls.albums.map((a) => ({ title: a.title, artist: a.artist || undefined, mode: a.mode })),
      steer: controls.steer.trim() ? {
        text: controls.steer.trim(),
        songs_played_since_set: songsPlayedSince(history, controls.steerSetAt)
      } : null
    }
  };
}

function trackKey(t) {
  return `${norm(t.title)}\u0000${norm(t.artist)}`;
}

// Whole-word match so "Queen" blocks "Queen & David Bowie" but not "Queens of the Stone Age".
export function artistMatches(artist, name) {
  const a = ` ${norm(artist)} `;
  const n = norm(name);
  return !!n && a.includes(` ${n} `);
}

// Drops repeats, avoided artists, duplicates and malformed entries, then trims to `count`.
export function filterPicks(songs, { nowPlaying, history, queued = [], disliked = [], avoidArtists = [], count }) {
  const blocked = new Set(
    [nowPlaying, ...history.slice(0, HISTORY_IN_PROMPT), ...queued, ...disliked].filter(Boolean).map(trackKey)
  );
  const out = [];
  for (const s of Array.isArray(songs) ? songs : []) {
    if (!s || typeof s.title !== 'string' || typeof s.artist !== 'string') continue;
    const title = s.title.trim();
    const artist = s.artist.trim();
    if (!title || !artist) continue;
    const key = trackKey({ title, artist });
    if (blocked.has(key)) continue;
    if (avoidArtists.some((name) => artistMatches(artist, name))) continue;
    blocked.add(key);
    out.push({
      title,
      artist,
      album: typeof s.album === 'string' ? s.album.trim() : '',
      reason: typeof s.reason === 'string' ? s.reason.trim() : ''
    });
    if (out.length >= count) break;
  }
  return out;
}
