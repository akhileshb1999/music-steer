// Isolated-world relay between the page (ytm-adapter.js, MAIN world) and the extension.
// The MAIN world can't call chrome.runtime, and the isolated world can't see the page's JS objects.
//
//   page -> extension: nowPlaying / trackPlayed events
//   extension -> page: { type: 'ytm', op, args } requests, answered with the adapter's result
(() => {
  const PAGE = 'music-steer:page';
  const EXT = 'music-steer:ext';
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE || typeof data.type !== 'string') return;

    if (data.type === 'rpcResult') {
      const done = pending.get(data.id);
      if (done) done({ ok: data.ok, result: data.result, error: data.error });
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: data.type, track: data.track }).catch(() => {});
    } catch {
      // Extension was reloaded; this content script is orphaned until the tab reloads.
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'ytm' || sender.id !== chrome.runtime.id) return;
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      sendResponse({ ok: false, error: 'The YouTube Music tab did not answer in time.' });
    }, msg.timeout || 20000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      pending.delete(id);
      sendResponse(reply);
    });
    window.postMessage({ source: EXT, id, op: msg.op, args: msg.args }, location.origin);
    return true; // answer asynchronously
  });
})();
