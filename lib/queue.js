// Pure bookkeeping for the steered queue (no chrome.*), tested in Node.

import { norm } from './state.js';

const SKIP_LIMIT = 50;

// Matches what we think we queued against the real queue. Songs before the current one have played;
// steered songs that vanished without playing were removed by you (they go on the skip list).
export function reconcile(items, queue, np) {
  const sel = queue.selectedIndex;
  const current = sel >= 0 ? queue.items[sel].videoIds : (np && np.videoId ? [np.videoId] : []);
  const kept = [];
  const removed = [];
  for (const it of items) {
    if (current.includes(it.videoId)) {
      kept.push({ ...it, status: 'playing', pos: sel });
      continue;
    }
    const pos = queue.items.findIndex((q, i) => i > sel && q.videoIds.includes(it.videoId));
    if (pos >= 0) {
      kept.push({ ...it, status: 'queued', pos });
      continue;
    }
    const played = it.status === 'playing' || queue.items.some((q, i) => i < sel && q.videoIds.includes(it.videoId));
    if (!played) removed.push(it);
  }
  kept.sort((a, b) => a.pos - b.pos);
  return { items: kept.map(({ pos, ...x }) => x), removed };
}

export function addSkips(skip, songs, why) {
  const key = (s) => `${norm(s.title)}|${norm(s.artist)}`;
  const fresh = songs.map((s) => ({ title: s.title, artist: s.artist, why }));
  const seen = new Set();
  return [...fresh, ...skip].filter((s) => !seen.has(key(s)) && seen.add(key(s))).slice(0, SKIP_LIMIT);
}

