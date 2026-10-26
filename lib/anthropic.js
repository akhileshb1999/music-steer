// Anthropic Messages API client (paid, pay-as-you-go; keys at https://console.anthropic.com).

import { SYSTEM_PROMPT, PICKS_SCHEMA } from './prompt.js';
import { ApiError, withOneRetry } from './api-error.js';

export const MODEL = 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1';
const EFFORT = 'low';         // song picking is mostly recall; low keeps it fast and cheap
const MAX_TOKENS = 8000;      // room for thinking + the JSON reply
const TIMEOUT_MS = 90000;

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
  if (res.status === 401) throw new ApiError('Anthropic API key was rejected. Check it in Options.', { status: 401 });
  if (res.status === 403) throw new ApiError(`Access denied: ${message}`, { status: 403 });
  const retryable = res.status === 429 || res.status >= 500;
  throw new ApiError(`${res.status === 429 ? 'Rate limited' : 'API error'}: ${message}`, {
    status: res.status, retryable, retryAfter: Number(res.headers.get('retry-after')) || null
  });
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

  const data = await withOneRetry(() => postMessages(apiKey, body));

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
  const u = data.usage || {};
  return { songs: parsed.songs || [], usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 } };
}
