// Error from an AI provider, with a message fit to show in the panel.
export class ApiError extends Error {
  constructor(message, { status = null, retryable = false, retryAfter = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter; // seconds, when the provider says
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries once on a retryable error, waiting what the provider asked for (capped so the panel doesn't hang).
export async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ApiError) || !err.retryable) throw err;
    await sleep(Math.min((err.retryAfter || 3) * 1000, 20000));
    return fn();
  }
}
