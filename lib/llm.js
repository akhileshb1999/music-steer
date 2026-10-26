// Picks the AI provider set in Options and gives the rest of the extension one interface.

import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';
import { ApiError } from './api-error.js';

export const PROVIDERS = {
  gemini: { name: 'Gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  anthropic: { name: 'Claude', keyUrl: 'https://console.anthropic.com/settings/keys' }
};

// settings: { provider, apiKey (Anthropic), geminiKey, geminiModel } from getAiSettings()
export function keyFor(settings) {
  return settings.provider === 'anthropic' ? settings.apiKey : settings.geminiKey;
}

export function providerName(settings) {
  return (PROVIDERS[settings.provider] || PROVIDERS.gemini).name;
}

export async function requestPicks(settings, payload) {
  const key = keyFor(settings);
  if (!key) throw new ApiError(`Add your ${providerName(settings)} API key in Options.`);
  if (settings.provider === 'anthropic') return anthropic.requestPicks(key, payload);
  return gemini.requestPicks(key, settings.geminiModel, payload);
}

export async function testKey(settings) {
  const key = keyFor(settings);
  if (settings.provider === 'anthropic') return anthropic.testKey(key);
  return gemini.testKey(key, settings.geminiModel);
}
