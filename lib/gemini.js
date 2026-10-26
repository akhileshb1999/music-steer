// Google Gemini API client (generateContent). Has a free tier: get a key at https://aistudio.google.com/apikey
// Note Google's terms: on the free tier, what you send may be used to improve Google's products.

import { SYSTEM_PROMPT } from './prompt.js';
import { ApiError, withOneRetry } from './api-error.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
// Other free-tier models to try, in order, when the chosen one is overloaded or out of free quota
// (free-tier limits are per model, so a busy model doesn't mean the others are).
export const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];
const API = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 90000;

// Gemini's responseSchema is an OpenAPI-style subset (no additionalProperties).
export const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    songs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          artist: { type: 'STRING' },
          album: { type: 'STRING' },
          reason: { type: 'STRING' }
        },
        required: ['title', 'artist', 'album', 'reason'],
        propertyOrdering: ['title', 'artist', 'album', 'reason']
      }
    }
  },
  required: ['songs']
};

function headers(apiKey) {
  return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
}

function cleanModel(model) {
  return (model || '').trim().replace(/^models\//, '') || DEFAULT_GEMINI_MODEL;
}

function modelPath(model) {
  return `models/${encodeURIComponent(cleanModel(model))}`;
}

export function modelChain(model) {
  const first = cleanModel(model);
  return [first, ...FALLBACK_MODELS.filter((m) => m !== first)];
}

// Worth trying the next model: overloaded, out of free quota, retired, timed out, or a garbled reply.
function canFallBack(err) {
  return [404, 429, 500, 502, 503, 504].includes(err.status) || (err.status == null && err.retryable);
}

// Turns a Google error response into a message for the panel.
async function toApiError(res) {
  let body = null;
  try { body = await res.json(); } catch {}
  const err = (body && body.error) || {};
  const details = err.details || [];
  const reason = (details.find((d) => d.reason) || {}).reason;
  const retry = details.find((d) => d.retryDelay);
  const retryAfter = retry ? parseFloat(retry.retryDelay) : null;
  const message = err.message || `HTTP ${res.status}`;

  if (reason === 'API_KEY_INVALID' || res.status === 401) {
    return new ApiError('Gemini API key was rejected. Check it in Options.', { status: res.status });
  }
  if (res.status === 403) return new ApiError(`Gemini refused access: ${message}`, { status: 403 });
  if (res.status === 404) {
    return new ApiError(`Gemini model not found. Check the model name in Options. (${message})`, { status: 404 });
  }
  if (res.status === 429) {
    return new ApiError('Gemini free-tier limit reached for now. Steering will retry in a minute.', { status: 429, retryable: true, retryAfter });
  }
  if (res.status >= 500) return new ApiError(`Gemini is busy: ${message}`, { status: res.status, retryable: true, retryAfter });
  return new ApiError(`Gemini error: ${message}`, { status: res.status });
}

async function call(url, apiKey, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, headers: headers(apiKey), signal: ctrl.signal });
  } catch (err) {
    throw new ApiError(err.name === 'AbortError' ? 'Gemini request timed out' : `Network error: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// Checks the key and the model without spending quota (model metadata lookup).
export async function testKey(apiKey, model) {
  const res = await call(`${API}/${modelPath(model)}`, apiKey);
  if (res.ok) return { ok: true };
  const err = await toApiError(res);
  return { ok: false, status: err.status, message: err.message };
}

export function buildRequest(payload) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: `Pick the next ${payload.count} songs.\n\n${JSON.stringify(payload, null, 1)}` }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS }
  };
}

export function parseResponse(data) {
  const blocked = data.promptFeedback && data.promptFeedback.blockReason;
  if (blocked) throw new ApiError(`Gemini blocked this request (${blocked}). Try rewording the steer text.`);
  const cand = (data.candidates || [])[0];
  if (!cand) throw new ApiError('Gemini returned no answer. Try again.', { retryable: true });
  if (cand.finishReason === 'MAX_TOKENS') throw new ApiError('Gemini’s reply was cut off. Try again.', { retryable: true });
  if (cand.finishReason && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)) {
    throw new ApiError(`Gemini stopped early (${cand.finishReason}). Try rewording the steer text.`);
  }
  const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('Gemini returned something that was not valid JSON. Try again.', { retryable: true });
  }
  const u = data.usageMetadata || {};
  return {
    songs: (parsed && parsed.songs) || [],
    usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }
  };
}

async function generate(apiKey, model, body) {
  const res = await call(`${API}/${modelPath(model)}:generateContent`, apiKey, { method: 'POST', body });
  if (!res.ok) throw await toApiError(res);
  return parseResponse(await res.json());
}

// Tries the chosen model, then the free fallbacks. Returns { songs, usage, model } (the model that answered).
export async function requestPicks(apiKey, model, payload) {
  const body = JSON.stringify(buildRequest(payload));
  const chain = modelChain(model);
  let last = null;
  for (const m of chain) {
    try {
      // A dropped connection gets one more try on the same model before moving on.
      const r = await withOneRetry(() => generate(apiKey, m, body).catch((err) => {
        if (err instanceof ApiError && err.status != null) err.retryable = false; // HTTP errors: move on instead
        throw err;
      }));
      return { ...r, model: m };
    } catch (err) {
      if (!(err instanceof ApiError) || !canFallBack(err)) throw err;
      last = err;
    }
  }
  const quota = last && last.status === 429;
  throw new ApiError(
    quota
      ? `Gemini's free-tier limit is used up on every free model for now (tried ${chain.join(', ')}). Steering will retry in a minute.`
      : `Gemini is busy right now (tried ${chain.join(', ')}). Spikes are usually short; steering will retry in a minute.`,
    { status: last && last.status, retryable: true }
  );
}
