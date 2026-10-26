// Anthropic Messages API client. The only third-party host this extension talks to.

import { SYSTEM_PROMPT, PICKS_SCHEMA } from './prompt.js';

export const MODEL = 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1';
const EFFORT = 'low';         // song picking is mostly recall; low keeps it fast and cheap
const MAX_TOKENS = 8000;      // room for thinking + the JSON reply
const TIMEOUT_MS = 90000;

export class ApiError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json'
  };
}

async function errorMessage(res) {
  try {
    const body = await res.json();
    if (body && body.error && body.error.message) return body.error.message;
  } catch {}
  return `HTTP ${res.status}`;
}

// Checks the key and model access without spending tokens (Models API is free).
export async function testKey(apiKey) {
  const res = await fetch(`${API}/models/${MODEL}`, { headers: headers(apiKey) });
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status, message: await errorMessage(res) };
}

async function postMessages(apiKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${API}/messages`, {
      method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: ctrl.signal
    });
  } catch (err) {
    throw new ApiError(err.name === 'AbortError' ? 'Request timed out' : `Network error: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return res.json();

  const message = await errorMessage(res);
  if (res.status === 401) throw new ApiError('API key was rejected. Check it in Options.', { status: 401 });
  if (res.status === 403) throw new ApiError(`Access denied: ${message}`, { status: 403 });
  const retryable = res.status === 429 || res.status >= 500;
  const err = new ApiError(`${res.status === 429 ? 'Rate limited' : 'API error'}: ${message}`, { status: res.status, retryable });
  err.retryAfter = Number(res.headers.get('retry-after')) || null;
  throw err;
}

// Asks Claude for song picks. `payload` comes from buildPayload() in prompt.js.
// Returns { songs, usage }. Songs are unfiltered; run filterPicks() on them.
export async function requestPicks(apiKey, payload) {
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT, format: { type: 'json_schema', schema: PICKS_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Pick the next ${payload.count} songs.\n\n${JSON.stringify(payload, null, 1)}`
    }]
  };

  let data;
  try {
    data = await postMessages(apiKey, body);
  } catch (err) {
    if (!(err instanceof ApiError) || !err.retryable) throw err;
    // One retry, honoring retry-after when the API sends it (capped so the panel doesn't hang).
    const wait = Math.min((err.retryAfter || 3) * 1000, 20000);
    await new Promise((r) => setTimeout(r, wait));
    data = await postMessages(apiKey, body);
  }

  if (data.stop_reason === 'refusal') {
    const cat = data.stop_details && data.stop_details.category;
    throw new ApiError(`Claude declined this request${cat ? ` (${cat})` : ''}. Try rewording the steer text.`);
  }
  if (data.stop_reason === 'max_tokens') {
    throw new ApiError('The reply was cut off (max_tokens). Try again.', { retryable: true });
  }

  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('Claude returned something that was not valid JSON. Try again.');
  }
  return { songs: parsed.songs || [], usage: data.usage || null };
}
