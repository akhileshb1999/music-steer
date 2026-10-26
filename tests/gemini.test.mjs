import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, requestPicks, testKey, modelChain, DEFAULT_GEMINI_MODEL, FALLBACK_MODELS } from '../lib/gemini.js';
import { ApiError } from '../lib/api-error.js';

const payload = { count: 3, controls: { energy: { value: 70 } } };
const songs = [{ title: 'La Grange', artist: 'ZZ Top', album: 'Tres Hombres', reason: 'Boogie riff' }];
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const answer = (s = songs, extra = {}) => ({
  candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify({ songs: s }) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 100 },
  ...extra
});

test('request asks for JSON matching the songs schema, with the system prompt', () => {
  const r = buildRequest(payload);
  assert.equal(r.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(r.generationConfig.responseSchema.required, ['songs']);
  assert.equal(r.generationConfig.responseSchema.properties.songs.items.properties.reason.type, 'STRING');
  assert.match(r.systemInstruction.parts[0].text, /DJ/);
  assert.match(r.contents[0].parts[0].text, /^Pick the next 3 songs/);
  assert.equal(JSON.parse(r.contents[0].parts[0].text.split('\n\n')[1]).controls.energy.value, 70);
});

test('parseResponse skips thought parts and normalizes usage', () => {
  const r = parseResponse(answer());
  assert.deepEqual(r.songs, songs);
  assert.deepEqual(r.usage, { input: 1200, output: 400 });
});

test('parseResponse reports blocks, truncation and bad JSON', () => {
  assert.throws(() => parseResponse({ promptFeedback: { blockReason: 'SAFETY' } }), /blocked/);
  assert.throws(() => parseResponse({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }), /cut off/);
  assert.throws(() => parseResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'nope' }] } }] }), /not valid JSON/);
});

test('requestPicks sends the key header to the default model', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init }); return ok(answer()); });
  const r = await requestPicks('AIzaTEST', '', payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaTEST');
  assert.equal(r.songs[0].title, 'La Grange');
  assert.equal(r.model, DEFAULT_GEMINI_MODEL);
});

const busy = () => new Response(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }), { status: 503 });
const quota = () => new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted', details: [{ retryDelay: '30s' }] } }), { status: 429 });
const modelOf = (url) => url.match(/models\/([^:]+):/)[1];

test('a busy (503) or out-of-quota (429) model falls back to the next free model', async (t) => {
  const tried = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    tried.push(modelOf(url));
    if (tried.length === 1) return busy();
    if (tried.length === 2) return quota();
    return ok(answer());
  });
  const r = await requestPicks('k', '', payload);
  assert.deepEqual(tried, [DEFAULT_GEMINI_MODEL, ...FALLBACK_MODELS.slice(0, 2)]);
  assert.equal(r.model, FALLBACK_MODELS[1]);
});

test('when every model is busy, the error says so and is retryable later', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => { n++; return busy(); });
  await assert.rejects(requestPicks('k', '', payload), (e) => e instanceof ApiError && /busy right now/.test(e.message) && e.retryable);
  assert.equal(n, modelChain('').length, 'each model tried once, no waiting');
});

test('a chosen model is tried first and not repeated in the fallbacks', () => {
  assert.deepEqual(modelChain('gemini-2.5-flash'), ['gemini-2.5-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(modelChain(' models/gemini-3.8-flash '), [DEFAULT_GEMINI_MODEL, ...FALLBACK_MODELS]);
});

test('a bad key gives a clear message and is not retried', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    n++;
    return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }), { status: 400 });
  });
  await assert.rejects(requestPicks('bad', 'gemini-3.8-flash', payload), (e) => e instanceof ApiError && /key was rejected/.test(e.message));
  assert.equal(n, 1);
  const k = await testKey('bad', '');
  assert.equal(k.ok, false);
  assert.match(k.message, /key was rejected/);
});

test('custom model names are used (and a "models/" prefix is tolerated)', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(url); return ok(answer()); });
  await requestPicks('k', 'models/gemini-2.5-flash', payload);
  assert.match(urls[0], /\/models\/gemini-2\.5-flash:generateContent$/);
});
