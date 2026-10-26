// Gradual drift: when you change the controls in "gradual" mode, steering moves from the old settings
// to the new ones over N songs instead of switching at once. Pure functions (no chrome.*), tested in Node.
//
// A drift is stored as { from, startedAt, of }: the effective controls when the change was made,
// when it started, and over how many songs. The target is always the current controls, so further
// edits during a drift just restart it from wherever it had got to.

import { norm } from './state.js';

const SLIDERS = ['energy', 'heaviness', 'tempo', 'popularity', 'discovery'];
// Fields that only say how to drift, not where to; changing them doesn't change the direction.
const META = ['driftMode', 'driftSongs', 'steerSetAt'];

export function directionOf(controls) {
  const c = { ...controls };
  for (const k of META) delete c[k];
  return c;
}

export function sameDirection(a, b) {
  return JSON.stringify(directionOf(a)) === JSON.stringify(directionOf(b));
}

const lerp = (a, b, t) => a + (b - a) * t;

function lerpEra(a, b, t) {
  if (a == null || b == null) return t < 0.5 ? a : b;
  return Math.round(lerp(a, b, t) / 10) * 10;
}

function lerpGenres(from, to, t) {
  const byKey = new Map();
  for (const g of from) byKey.set(norm(g.name), { name: g.name, a: g.weight, b: 0 });
  for (const g of to) {
    const k = norm(g.name);
    const cur = byKey.get(k);
    if (cur) { cur.b = g.weight; cur.name = g.name; } else byKey.set(k, { name: g.name, a: 0, b: g.weight });
  }
  return [...byKey.values()]
    .map((g) => ({ name: g.name, weight: Math.round(lerp(g.a, g.b, t)) }))
    .filter((g) => g.weight > 0);
}

// Controls part-way (t = 0..1) from `from` to `to`. Sliders, genre weights and era move smoothly.
// Hard rules (exclude genres, avoid artists) and the text-like fields come from `to`; what the listener
// is moving away from is reported separately by fadingOut().
export function interpolate(from, to, t) {
  t = Math.min(1, Math.max(0, t));
  const out = structuredClone(to);
  for (const k of SLIDERS) out[k] = Math.round(lerp(from[k], to[k], t));
  out.genres = lerpGenres(from.genres || [], to.genres || [], t);
  out.eraFrom = lerpEra(from.eraFrom, to.eraFrom, t);
  out.eraTo = lerpEra(from.eraTo, to.eraTo, t);
  if (out.eraFrom != null && out.eraTo != null && out.eraFrom > out.eraTo) out.eraTo = out.eraFrom;
  return out;
}

export function fadingOut(from, to) {
  const has = (list, key) => new Set((list || []).map((x) => norm(key(x))));
  const toSeeds = has(to.seedArtists, (a) => a.name);
  const toAlbums = has(to.albums, (a) => `${a.title} ${a.artist}`);
  const out = {
    seed_artists: (from.seedArtists || []).filter((a) => !toSeeds.has(norm(a.name))).map((a) => ({ name: a.name, note: a.note || undefined })),
    albums: (from.albums || []).filter((a) => !toAlbums.has(norm(`${a.title} ${a.artist}`))).map((a) => ({ title: a.title, artist: a.artist || undefined, mode: a.mode })),
    steer: from.steer && from.steer.trim() !== (to.steer || '').trim() ? from.steer.trim() : undefined
  };
  if (!out.seed_artists.length) delete out.seed_artists;
  if (!out.albums.length) delete out.albums;
  return out;
}

export function songsSince(history, ts) {
  return history.filter((h) => h.playedAt > ts).length;
}

// What steering should use right now: { controls, drift } where drift is null or { step, of, fading_out }.
export function effectiveControls(controls, drift, history) {
  if (!drift || controls.driftMode !== 'gradual') return { controls, drift: null };
  const step = songsSince(history, drift.startedAt);
  if (step >= drift.of) return { controls, drift: null };
  return {
    controls: interpolate(drift.from, controls, step / drift.of),
    drift: { step, of: drift.of, fading_out: fadingOut(drift.from, controls) }
  };
}

// Called when the controls settle after an edit. Returns the new { drift, lastApplied } to store.
export function nextDrift({ controls, lastApplied, drift, history, now = Date.now() }) {
  if (controls.driftMode !== 'gradual' || !lastApplied) return { drift: null, lastApplied: controls };
  const current = effectiveControls({ ...lastApplied, driftMode: 'gradual' }, drift, history).controls;
  return { drift: { from: directionOf(current), startedAt: now, of: controls.driftSongs }, lastApplied: controls };
}
