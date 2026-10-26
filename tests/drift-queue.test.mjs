import test from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, fadingOut, effectiveControls, nextDrift, sameDirection } from '../lib/drift.js';
import { reconcile, addSkips } from '../lib/queue.js';
import { DEFAULT_CONTROLS } from '../lib/state.js';

const C = (over = {}) => ({ ...structuredClone(DEFAULT_CONTROLS), ...over });

test('interpolate moves sliders, genre weights and era part-way', () => {
  const from = C({ energy: 90, genres: [{ name: 'hard rock', weight: 100 }], eraFrom: 1990, eraTo: 1990 });
  const to = C({ energy: 10, genres: [{ name: 'soft rock', weight: 100 }], eraFrom: 1970, eraTo: 1970, avoidArtists: ['Nickelback'] });
  const mid = interpolate(from, to, 0.5);
  assert.equal(mid.energy, 50);
  assert.deepEqual(mid.genres, [{ name: 'hard rock', weight: 50 }, { name: 'soft rock', weight: 50 }]);
  assert.equal(mid.eraFrom, 1980);
  assert.deepEqual(mid.avoidArtists, ['Nickelback'], 'hard rules apply immediately');
  assert.deepEqual(interpolate(from, to, 1).genres, [{ name: 'soft rock', weight: 100 }]);
  assert.equal(interpolate(from, to, 0).energy, 90);
});

test('era with "any" on one side switches at the midpoint', () => {
  const from = C({ eraFrom: null, eraTo: null });
  const to = C({ eraFrom: 1970, eraTo: 1970 });
  assert.equal(interpolate(from, to, 0.4).eraFrom, null);
  assert.equal(interpolate(from, to, 0.6).eraFrom, 1970);
});

test('fadingOut lists what the listener is moving away from', () => {
  const from = C({ seedArtists: [{ name: 'Rush', note: '' }, { name: 'Yes', note: '' }], steer: 'prog epics' });
  const to = C({ seedArtists: [{ name: 'Yes', note: '' }], steer: 'short songs' });
  assert.deepEqual(fadingOut(from, to), { seed_artists: [{ name: 'Rush', note: undefined }], steer: 'prog epics' });
});

test('effectiveControls follows songs played since the drift started, then ends', () => {
  const to = C({ driftMode: 'gradual', energy: 0 });
  const drift = { from: C({ energy: 100 }), startedAt: 1000, of: 4 };
  const hist = (n) => Array.from({ length: n }, (_, i) => ({ playedAt: 2000 + i }));
  assert.equal(effectiveControls(to, drift, hist(0)).controls.energy, 100);
  const two = effectiveControls(to, drift, hist(2));
  assert.equal(two.controls.energy, 50);
  assert.equal(two.drift.step, 2);
  assert.equal(effectiveControls(to, drift, hist(4)).drift, null);
  assert.equal(effectiveControls({ ...to, driftMode: 'snap' }, drift, hist(1)).drift, null);
});

test('nextDrift starts from wherever the current drift had got to', () => {
  const history = [{ playedAt: 2000 }, { playedAt: 2001 }];
  const lastApplied = C({ driftMode: 'gradual', energy: 0 });
  const drift = { from: C({ energy: 100 }), startedAt: 1000, of: 4 };
  const r = nextDrift({ controls: C({ driftMode: 'gradual', driftSongs: 6, energy: 80 }), lastApplied, drift, history, now: 5000 });
  assert.equal(r.drift.from.energy, 50);
  assert.equal(r.drift.of, 6);
  assert.equal(r.drift.startedAt, 5000);
  assert.equal(nextDrift({ controls: C({ energy: 80 }), lastApplied, drift, history }).drift, null, 'snap clears drift');
});

test('sameDirection ignores drift settings and the steer timestamp', () => {
  assert.ok(sameDirection(C(), C({ driftMode: 'gradual', driftSongs: 9, steerSetAt: 5 })));
  assert.ok(!sameDirection(C(), C({ energy: 51 })));
});

const Q = (ids, sel) => ({ selectedIndex: sel, items: ids.map((id) => ({ videoIds: Array.isArray(id) ? id : [id] })) });

test('reconcile marks playing/queued, drops played, reports removed', () => {
  const items = [
    { videoId: 'a', status: 'playing' },  // finished, now before current
    { videoId: 'b', status: 'queued' },   // now playing
    { videoId: 'c', status: 'queued' },   // still waiting
    { videoId: 'd', status: 'queued' },   // vanished: removed by the user
    { videoId: 'e', status: 'queued' }    // skipped past: before current
  ];
  const { items: kept, removed } = reconcile(items, Q(['a', 'e', ['b', 'b-video'], 'x', 'c'], 2), null);
  assert.deepEqual(kept.map((i) => [i.videoId, i.status]), [['b', 'playing'], ['c', 'queued']]);
  assert.deepEqual(removed.map((i) => i.videoId), ['d']);
});

test('reconcile matches the video version of a song', () => {
  const { items } = reconcile([{ videoId: 'song', status: 'queued' }], Q(['now', ['other', 'song']], 0), null);
  assert.equal(items[0].status, 'queued');
});

test('addSkips dedupes newest first and caps the list', () => {
  const s = addSkips([{ title: 'A', artist: 'X', why: 'removed' }], [{ title: 'a', artist: 'x' }, { title: 'B', artist: 'Y' }], 'not_found');
  assert.deepEqual(s.map((x) => [x.title, x.why]), [['a', 'not_found'], ['B', 'not_found']]);
  assert.equal(addSkips([], Array.from({ length: 80 }, (_, i) => ({ title: `t${i}`, artist: 'a' })), 'x').length, 50);
});
