// Isolated-world relay between the page (ytm-adapter.js, MAIN world) and the extension.
// The MAIN world can't call chrome.runtime, and the isolated world can't see the page's JS objects.
(() => {
  const PAGE = 'music-steer:page';

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE || typeof data.type !== 'string') return;
    try {
      chrome.runtime.sendMessage({ type: data.type, track: data.track }).catch(() => {});
    } catch {
      // Extension was reloaded; this content script is orphaned until the tab reloads.
    }
  });
})();
