import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseResponse, requestPicks, testKey, DEFAULT_GEMINI_MODEL } from '../lib/gemini.js';
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

test('requestPicks sends the key header to the default model and retries once on 429', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { code: 429, message: 'Resource exhausted', details: [{ retryDelay: '0.01s' }] } }), { status: 429 });
    }
    return ok(answer());
  });
  const r = await requestPicks('AIzaTEST', '', payload);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIzaTEST');
  assert.equal(r.songs[0].title, 'La Grange');
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
