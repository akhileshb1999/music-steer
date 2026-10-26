# Music Steer

A Chrome extension (Manifest V3) for steering what plays next on YouTube Music (music.youtube.com). You set the direction in a side panel: genres with weights, tone sliders, seed and avoid artists, albums, and a free-text steer. An AI then picks songs, and the extension keeps 3–5 of them queued right after the current song.

Two AI options, chosen in Options:
- **Google Gemini** (default): free tier, using `gemini-3.8-flash`. If that model is busy or out of free quota, it automatically tries `gemini-3.6-flash`, `gemini-2.5-flash` and `gemini-3.5-flash-lite`. Get a key at https://aistudio.google.com/apikey.
- **Claude** (Anthropic): paid, using `claude-sonnet-5-5`, about 5–10 cents per hour of listening. Get a key at https://console.anthropic.com.

Plain JavaScript, HTML and CSS. No build step.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
4. Pin **Music Steer** from the puzzle-piece menu so its icon stays in the toolbar.
5. Open (or reload) a music.youtube.com tab. Content scripts only attach to tabs loaded after the extension.
6. Click the toolbar icon to open the side panel.

After pulling new code: click ↻ on the extension's card in `chrome://extensions`, then reload the YouTube Music tab.

The API key goes in **Options**: the link at the bottom of the panel, or right-click the toolbar icon → Options. Pick the provider, paste the key, and press **Test**. Keys are stored in `chrome.storage.local` and sent only to the provider you picked.

## Using it

- **Steering** (switch in the "Up next" card): while on, Music Steer keeps 3–5 steered songs queued right after the current song, topping up as they play. It keeps running with the panel closed, as long as the YouTube Music tab is open.
- **Refresh** replaces the steered songs that haven't played yet.
- **✕** on a song removes it from the queue. That song won't be picked again this session.
- **👎** removes the song and adds it to **Disliked**. Every request tells the AI to avoid disliked songs, and songs like them, using the reason you type next to each one. 👎 on the now-playing card dislikes the current song.
- **Drift: Snap** replaces the queued steered songs as soon as you change a control. **Gradual** keeps them and moves the picks from the old settings to the new ones over N songs: sliders, genre weights and era blend step by step, and artists, albums or steer text you removed fade out.
- **Presets** save and load a full set of controls by name. Export/Import moves them between browsers as a JSON file.

Songs you queued yourself and YouTube Music's autoplay suggestions are never touched. Steered songs are inserted ahead of them.

## How it works

```
manifest.json
background.js            service worker: the steering loop, triggers, panel actions
lib/state.js             storage layout + defaults
lib/prompt.js            system prompt, request payload, JSON schema, filtering of picks
lib/drift.js             gradual drift (pure functions)
lib/queue.js             matching steered songs against the real queue (pure functions)
lib/llm.js               picks the provider set in Options
lib/gemini.js            Google Gemini API client (generateContent, JSON schema output)
lib/anthropic.js         Anthropic API client
lib/api-error.js         shared error type + one-retry helper
content/ytm-adapter.js   MAIN world: everything that depends on YouTube Music's page
content/bridge.js        isolated world: relays page <-> extension
panel/                   side panel
options/                 API key page
tools/probe.js           DevTools snippet that checks the YouTube Music internals the adapter uses
tests/                   unit tests (node --test) and an end-to-end test against a fake YTM page
```

**A steering pass** runs on a song change, a control change, a 👎/✕, Refresh, or a 1-minute heartbeat:
1. Read the queue and work out which steered songs are playing, still waiting, or gone.
2. On a snap change or Refresh, take the waiting steered songs out.
3. If fewer than 3 are waiting, ask the AI for enough to get back to 5, plus 2 spares.
4. Find each song on YouTube Music, preferring the studio song over live versions, covers and uploads.
5. Insert them in order right after the current song.

"Play next" only inserts directly after the current song. To keep older picks first, the waiting steered songs are taken out and everything is put back in order.

**Picks** come from the AI model's own music knowledge. Each request sends:
- your controls (blended, if drifting)
- the current track and the last 20 played
- songs already queued
- dislikes with their reasons, and songs skipped this session
- the artists you know: play history, seed artists, and your YouTube Music library (followed artists and liked songs, refreshed daily)

The reply is strict JSON (`{songs: [{title, artist, album, reason}]}`). Code then drops repeats, avoided artists and duplicates. The system prompt that explains each control to the model is in `lib/prompt.js`. Both providers get the same prompt and the same song-list format.

**YouTube Music** has no public queue API. `content/ytm-adapter.js` uses the page's own internals, chosen as the parts least likely to change:
- **Search:** the page's `youtubei/v1/search` endpoint. The "Songs" filter value is read from the result chips, never hard-coded.
- **Play next:** the same `queueAddEndpoint` command the "Play next" menu item carries, handed to the app through its own `yt-action` event.
- **Remove:** each queue item's own `removeFromQueueEndpoint`, with clicking its menu entry as a fallback.
- **Library:** `youtubei/v1/browse`, signed the same way the page signs its own requests.

When YouTube changes something, that file is the only one to fix.

**Spend guard:** one pass at a time, control changes wait 1.5 s to settle, and at most 20 AI calls per hour (`CALLS_PER_HOUR` in `lib/state.js`). Normal listening tops up about every 3 songs, which is roughly 4–6 calls an hour. That's well within Gemini's free-tier limits; if Google's limit is hit anyway, the panel says so and steering retries a minute later.

## Troubleshooting

The status line in the "Up next" card says what went wrong.

- **"Couldn't read the YouTube Music queue"**: click the player bar once to open the full player, then press Refresh.
- **"Couldn't add songs to the YouTube Music queue"**: YouTube probably changed something. Automatic retries pause for 30 minutes (Refresh retries now). Run `tools/probe.js` (below) and look at the `playNext` section.
- **"Gemini is busy right now"**: every free Gemini model was overloaded at that moment. These spikes are usually short, and steering retries every minute on its own.
- **"Can't reach the YouTube Music tab"**: reload the tab. This happens after the extension is reloaded or updated.
- Only one YouTube Music tab should be open while steering.

**Probe:** copy `tools/probe.js` into the DevTools console on music.youtube.com while a song plays. It prints a compact JSON report of what the adapter relies on. Run `await musicSteerProbe({ write: true })` to also test a real Play next + remove.

## Tests

```
node --test                 # unit tests, no dependencies
node tests/e2e/run.js       # end-to-end with Gemini; needs Playwright + Chromium
PROVIDER=anthropic node tests/e2e/run.js
```

The end-to-end test loads the real extension against `tests/e2e/fake-ytm.html` with the AI provider mocked. It checks filling, ordering, top-ups, ✕, 👎, snap and gradual changes, presets, and steering off.

## Privacy

The only third-party host contacted is the AI provider you picked: `generativelanguage.googleapis.com` (Gemini) or `api.anthropic.com` (Claude). Each request contains your controls, the current and recent songs, your dislikes and artist names from your library. **On Gemini's free tier, Google may use this to improve its products.** Anthropic doesn't train on API data by default. Search, queue and library actions use music.youtube.com's own endpoints under your normal session, the same requests the page makes when you click.
