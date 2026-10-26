// Google Gemini API client (generateContent). Has a free tier: get a key at https://aistudio.google.com/apikey
// Note Google's terms: on the free tier, what you send may be used to improve Google's products.

import { SYSTEM_PROMPT } from './prompt.js';
import { ApiError, withOneRetry } from './api-error.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
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

function modelPath(model) {
  return `models/${encodeURIComponent((model || DEFAULT_GEMINI_MODEL).replace(/^models\//, ''))}`;
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
  if (res.status >= 500) return new ApiError(`Gemini is having trouble: ${message}`, { status: res.status, retryable: true, retryAfter });
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

export async function requestPicks(apiKey, model, payload) {
  const body = JSON.stringify(buildRequest(payload));
  return withOneRetry(async () => {
    const res = await call(`${API}/${modelPath(model)}:generateContent`, apiKey, { method: 'POST', body });
    if (!res.ok) throw await toApiError(res);
    return parseResponse(await res.json());
  });
}
