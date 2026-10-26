// Run with: node --test   (from the repo root)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, filterPicks, artistMatches, songsPlayedSince, knownArtists } from '../lib/prompt.js';
import { DEFAULT_CONTROLS } from '../lib/state.js';

const controls = (over = {}) => ({ ...structuredClone(DEFAULT_CONTROLS), ...over });
const history = [
  { title: 'Echoes', artist: 'Pink Floyd', playedAt: 3000 },
  { title: 'Black Dog', artist: 'Led Zeppelin', playedAt: 2000 },
  { title: 'Paranoid', artist: 'Black Sabbath', playedAt: 1000 }
];

test('genre weights become shares that add to 100%', () => {
  const p = buildPayload({
    controls: controls({ genres: [{ name: 'hard rock', weight: 70 }, { name: 'blues rock', weight: 30 }] }),
    nowPlaying: null, history: [], count: 5
  });
  assert.deepEqual(p.controls.genres, [{ name: 'hard rock', share: '70%' }, { name: 'blues rock', share: '30%' }]);
});

test('era decades become a year range; null means any era', () => {
  assert.equal(buildPayload({ controls: controls(), nowPlaying: null, history: [], count: 5 }).controls.era, null);
  const p = buildPayload({ controls: controls({ eraFrom: 1970, eraTo: 1980 }), nowPlaying: null, history: [], count: 5 });
  assert.deepEqual(p.controls.era, { from: 1970, to: 1989 });
});

test('steer carries songs played since it was set', () => {
  const p = buildPayload({ controls: controls({ steer: ' softer ', steerSetAt: 1500 }), nowPlaying: null, history, count: 5 });
  assert.deepEqual(p.controls.steer, { text: 'softer', songs_played_since_set: 2 });
  assert.equal(songsPlayedSince(history, null), null);
});

test('payload includes now playing, history and known artists', () => {
  const p = buildPayload({
    controls: controls({ seedArtists: [{ name: 'Rush', note: '' }] }),
    nowPlaying: { title: 'Echoes', artist: 'Pink Floyd', album: 'Meddle', year: 1971 },
    history, count: 7
  });
  assert.equal(p.count, 7);
  assert.equal(p.now_playing.album, 'Meddle');
  assert.equal(p.recent_history.length, 3);
  assert.deepEqual(p.known_artists, ['Rush', 'Pink Floyd', 'Led Zeppelin', 'Black Sabbath']);
});

test('knownArtists dedupes ignoring case and accents', () => {
  const k = knownArtists([{ artist: 'Motörhead' }, { artist: 'motorhead' }], controls());
  assert.deepEqual(k, ['Motörhead']);
});

test('artistMatches is whole-word', () => {
  assert.ok(artistMatches('Queen & David Bowie', 'Queen'));
  assert.ok(!artistMatches('Queens of the Stone Age', 'Queen'));
  assert.ok(!artistMatches('Anyone', ''));
});

test('filterPicks drops repeats, avoided artists, duplicates and junk, then trims', () => {
  const songs = [
    { title: 'Echoes', artist: 'Pink Floyd', album: '', reason: 'now playing' },
    { title: 'black dog', artist: 'LED ZEPPELIN', album: '', reason: 'in history' },
    { title: 'Bohemian Rhapsody', artist: 'Queen', album: '', reason: 'avoided' },
    { title: 'Go With the Flow', artist: 'Queens of the Stone Age', album: 'Songs for the Deaf', reason: 'ok' },
    { title: 'Go With The Flow', artist: 'Queens Of The Stone Age', album: '', reason: 'dupe' },
    { title: '', artist: 'Nobody', album: '', reason: 'junk' },
    null,
    { title: 'Kashmir', artist: 'Led Zeppelin', album: 'Physical Graffiti', reason: 'ok' },
    { title: 'Iron Man', artist: 'Black Sabbath', album: 'Paranoid', reason: 'over count' }
  ];
  const out = filterPicks(songs, {
    nowPlaying: { title: 'Echoes', artist: 'Pink Floyd' }, history, avoidArtists: ['Queen'], count: 2
  });
  assert.deepEqual(out.map((s) => s.title), ['Go With the Flow', 'Kashmir']);
});
