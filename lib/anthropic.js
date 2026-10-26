// Anthropic Messages API client. The only third-party host this extension talks to.

export const MODEL = 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1';

function headers(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json'
  };
}

// Checks the key and model access without spending tokens (Models API is free).
export async function testKey(apiKey) {
  const res = await fetch(`${API}/models/${MODEL}`, { headers: headers(apiKey) });
  if (res.ok) return { ok: true };
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body && body.error && body.error.message) message = body.error.message;
  } catch {}
  return { ok: false, status: res.status, message };
}
