# Music Steer

A Chrome extension (Manifest V3) for steering what plays next on YouTube Music (music.youtube.com). You set the direction in a side panel: genres with weights, tone sliders, seed and avoid artists, albums, and a free-text steer. Claude (`claude-sonnet-5-5`) then picks the next songs.

Plain JavaScript, HTML and CSS. No build step.

## Status

| Phase | What | State |
|---|---|---|
| 1 | Side panel UI + reading the now-playing track | done |
| 2 | AI picks shown in the panel (not queued) | next |
| 3 | Search + add to queue, keep 3–5 steered songs ahead | |
| 4 | Presets, gradual drift, thumbs-down feedback | |

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
4. Pin **Music Steer** from the puzzle-piece menu so its icon stays in the toolbar.
5. Open (or reload) a music.youtube.com tab. Content scripts only attach to tabs loaded after the extension.
6. Click the toolbar icon to open the side panel.

After pulling new code: click ↻ on the extension's card in `chrome://extensions`, then reload the YouTube Music tab.

The API key goes in **Options**: the link at the bottom of the panel, or right-click the toolbar icon → Options. It is stored in `chrome.storage.local` and sent only to api.anthropic.com.

## Layout

```
manifest.json
background.js            service worker: receives now-playing/played events, stores history
lib/state.js             storage layout + defaults
lib/anthropic.js         Anthropic API client
content/ytm-adapter.js   MAIN world: everything that depends on YouTube Music's page
content/bridge.js        isolated world: relays page <-> extension
panel/                   side panel
options/                 API key page
```

`content/ytm-adapter.js` is the only file that knows how YouTube Music works. When YouTube changes its page, fix it there.

## Privacy

The only third-party host contacted is `api.anthropic.com`. Search and queue actions (from phase 3) use music.youtube.com's own endpoints under your normal session, the same requests the page makes when you click.
