// End-to-end test: loads the real extension in Chromium against a fake YouTube Music page
// (tests/e2e/fake-ytm.html) with the Anthropic API mocked, and drives steering through its paces.
//
// Needs Playwright with Chromium (npm i -D playwright && npx playwright install chromium).
// Run from the repo root:  node tests/e2e/run.js            (Gemini, the default provider)
//                          PROVIDER=anthropic node tests/e2e/run.js
//                          MODE=click|event|broken node tests/e2e/run.js   (which queue route the fake page honours)
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EXT = path.resolve(__dirname, '../..');
const DIR = __dirname;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'music-steer-e2e-'));
const PROVIDER = process.env.PROVIDER === 'anthropic' ? 'anthropic' : 'gemini';
const MODE = ['click', 'event', 'broken'].includes(process.env.MODE) ? process.env.MODE : 'behavior';
const FAKE = fs.readFileSync(DIR + '/fake-ytm.html', 'utf8');
const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const POOL = [
  ['Imaginary Song', 'Nobody Band'],            // not on YTM
  ['Bohemian Rhapsody', 'Queen'],               // avoided artist
  ['Hold Your Head Up', 'Argent'], ['Free Ride', 'The Edgar Winter Group'], ['Mississippi Queen', 'Mountain'],
  ['Highway Star', 'Deep Purple'], ['Statesboro Blues', 'The Allman Brothers Band'], ['Train Kept A-Rollin\'', 'Aerosmith'],
  ['Rock and Roll Hoochie Koo', 'Rick Derringer'], ['La Grange', 'ZZ Top'], ['Cat Scratch Fever', 'Ted Nugent'],
  ['Radar Love', 'Golden Earring'], ['Saturday Night Special', 'Lynyrd Skynyrd'], ['Black Betty', 'Ram Jam'],
  ['Fooled Around and Fell in Love', 'Elvin Bishop'], ['Smokin\'', 'Boston'], ['The Boys Are Back in Town', 'Thin Lizzy'],
  ['Strange Brew', 'Cream'], ['Oh Well', 'Fleetwood Mac'], ['Born to Be Wild', 'Steppenwolf'], ['American Woman', 'The Guess Who'],
  ['Spirit in the Sky', 'Norman Greenbaum'], ['Rocky Mountain Way', 'Joe Walsh'], ['Bad Company', 'Bad Company'],
  ['Slow Ride', 'Foghat'], ['Jessica', 'The Allman Brothers Band'], ['Gimme Three Steps', 'Lynyrd Skynyrd'],
  ['Hocus Pocus', 'Focus'], ['Frankenstein', 'The Edgar Winter Group'], ['Locomotive Breath', 'Jethro Tull'],
  ['Tush', 'ZZ Top'], ['Sweet Emotion', 'Aerosmith'], ['Long Train Runnin\'', 'The Doobie Brothers']
];
const catalog = {};
POOL.forEach(([t, a], i) => { if (i !== 0) catalog[norm(`${t} ${a}`)] = { videoId: `v${i}`, title: t, artist: a }; });
const byId = Object.fromEntries(Object.values(catalog).map((c) => [c.videoId, { title: c.title, artist: c.artist }]));

const artistRun = (a) => ({ text: a, navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } });
const listItem = (videoId, title, artist, type) => ({ musicResponsiveListItemRenderer: {
  playlistItemData: { videoId },
  overlay: { musicItemThumbnailOverlayRenderer: { content: { musicPlayButtonRenderer: { playNavigationEndpoint: { watchEndpoint: { videoId, watchEndpointMusicSupportedConfigs: { watchEndpointMusicConfig: { musicVideoType: type } } } } } } } },
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [artistRun(artist), { text: ' • ' }, { text: 'Some Album' }, { text: ' • ' }, { text: '4:00' }] } } }
  ] } });

const ytHeaders = [];
const providerHits = { anthropic: 0, gemini: 0 };
let geminiShapeOk = true;
const geminiModels = [];
let aiCalls = [];
let given = 0;
function nextSongs(count, payload) {
  const out = [];
  while (out.length < count && given < POOL.length) {
    const [title, artist] = POOL[given++];
    out.push({ title, artist, album: 'Some Album', reason: `Fits: energy ${payload.controls.energy.value}` });
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra = '') { results.push([cond ? 'PASS' : 'FAIL', name, extra]); console.log(cond ? 'PASS' : 'FAIL', name, extra); }

(async () => {
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  const errors = [];
  await ctx.route('https://api.anthropic.com/**', async (r) => {
    const req = r.request();
    if (req.method() !== 'POST') return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    providerHits.anthropic++;
    const body = JSON.parse(req.postData());
    const payload = JSON.parse(body.messages[0].content.split('\n\n').slice(1).join('\n\n'));
    aiCalls.push(payload);
    await sleep(400);
    const songs = nextSongs(payload.count, payload);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      id: 'm', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ songs }) }], usage: { input_tokens: 1500, output_tokens: 400 } }) });
  });
  await ctx.route('https://generativelanguage.googleapis.com/**', async (r) => {
    const req = r.request();
    if (req.method() !== 'POST') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"models/gemini-3.8-flash"}' });
    const body = JSON.parse(req.postData());
    geminiModels.push(req.url().match(/models\/([^:]+):/)[1]);
    geminiShapeOk = geminiShapeOk && req.headers()['x-goog-api-key'] === 'AIzaTEST' &&
      body.generationConfig.responseMimeType === 'application/json' && !!body.generationConfig.responseSchema;
    // The very first request gets the real-world "high demand" 503, to exercise the model fallback.
    if (geminiModels.length === 1) {
      return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE',
        message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } }) });
    }
    providerHits.gemini++;
    const payload = JSON.parse(body.contents[0].parts[0].text.split('\n\n').slice(1).join('\n\n'));
    aiCalls.push(payload);
    await sleep(400);
    const songs = nextSongs(payload.count, payload);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ songs }) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 400 } }) });
  });
  await ctx.route('https://music.youtube.com/youtubei/v1/**', async (r) => {
    const req = r.request();
    const h = req.headers();
    ytHeaders.push({ url: req.url(), auth: h.authorization || '', authuser: h['x-goog-authuser'] });
    const body = JSON.parse(req.postData());
    if (req.url().includes('/browse')) {
      const names = body.browseId === 'FEmusic_liked_videos' ? [] : ['Pink Floyd', 'Led Zeppelin', 'The Strokes'];
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ contents: names.map((n) => ({ musicResponsiveListItemRenderer: { flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: n }] } } }] } })) }) });
    }
    const q = norm(body.query);
    if (!body.params) {
      return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ contents: {
        chips: [{ chipCloudChipRenderer: { text: { runs: [{ text: 'Songs' }] }, uniqueId: 'Songs', navigationEndpoint: { searchEndpoint: { params: 'SONGSPARAM' } } } }],
        list: catalog[q] ? [listItem(catalog[q].videoId + 'ugc', catalog[q].title + ' (Live at Budokan)', 'Fan Uploads', 'MUSIC_VIDEO_TYPE_UGC')] : [] } }) });
    }
    const hit = catalog[q];
    const items = hit ? [listItem(hit.videoId + 'live', hit.title + ' (Live)', hit.artist, 'MUSIC_VIDEO_TYPE_ATV'), listItem(hit.videoId, hit.title, hit.artist, 'MUSIC_VIDEO_TYPE_ATV')] : [];
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({ contents: { list: items } }) });
  });
  await ctx.route('https://music.youtube.com/watch**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: FAKE }));

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;

  const ytm = await ctx.newPage();
  ytm.on('pageerror', (e) => errors.push('ytm: ' + e.message));
  await ytm.goto(`https://music.youtube.com/watch?v=cur0&mode=${MODE}`);
  await ytm.evaluate((c) => { window.__catalog = c; }, byId);

  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
  panel.on('console', (m) => { if (m.type() === 'error') errors.push('panel console: ' + m.text()); });
  await panel.setViewportSize({ width: 380, height: 1100 });
  await panel.goto(`chrome-extension://${id}/panel/panel.html`);
  await sleep(1500);

  const steerState = () => panel.evaluate(() => chrome.storage.session.get('steer').then((x) => x.steer || {}));
  const queue = () => ytm.evaluate(() => window.__queue());
  async function waitSteer(pred, ms = 40000) {
    const end = Date.now() + ms;
    let s;
    while (Date.now() < end) { s = await steerState(); if (pred(s)) return s; await sleep(400); }
    return s;
  }
  const upcoming = (qq) => qq.slice(qq.findIndex((x) => x.startsWith('*')) + 1);

  check('now playing shows year from new player bar', (await panel.textContent('#npMeta')).includes('1971'), await panel.textContent('#npMeta'));

  // ---- Steering on: fills 5 in order, keeps user's queue items after them
  check('no-key banner points to Options', !(await panel.locator('#keyWarning').isHidden()), await panel.textContent('#keyWarning'));
  await panel.evaluate((provider) => chrome.storage.local.set({ provider, apiKey: 'sk-ant-test', geminiKey: 'AIzaTEST', controls: { genres: [{ name: 'hard rock', weight: 70 }, { name: 'blues rock', weight: 30 }], avoidArtists: ['Queen'], energy: 70 } }), PROVIDER);
  await sleep(2000); // let the controls change settle (steering still off)
  await panel.click('.switch');

  if (MODE === 'broken') {
    const b = await waitSteer((x) => x.status === 'error', 90000);
    check('broken queue: clear error shown', /Couldn’t add songs/.test(b.error || ''), b.error);
    check('broken queue: all three routes tried and reported', b.diag && b.diag.attempts.map((a) => a.route).join() === 'menu-behavior,menu-click,service-request', JSON.stringify(b.diag && b.diag.attempts));
    check('broken queue: no songs added', (await queue()).length === 5);
    check('broken queue: "Copy details" button shown', !(await panel.locator('#copyDiag').isHidden()));
    check('broken queue: fails fast (one song tried, not every song)', (await ytm.evaluate(() => window.__events.length)) === 0);
    check('no page errors', errors.length === 0, errors.join(' | '));
    const failures = results.filter((r) => r[0] === 'FAIL').length;
    console.log(failures, 'failures');
    await ctx.close();
    fs.rmSync(PROFILE, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
  }

  let s = await waitSteer((x) => x.status === 'ok' && x.items && x.items.length >= 5);
  let q = await queue();
  console.log('queue:', q.join(' '));
  check('steering on queues 5 steered songs', s.items.filter((i) => i.status === 'queued').length === 5, JSON.stringify(s.items.map((i) => i.videoId)));
  const steeredIds = s.items.map((i) => i.videoId);
  check('steered songs sit right after current, in Claude order', JSON.stringify(upcoming(q).slice(0, 5)) === JSON.stringify(steeredIds), upcoming(q).join(' '));
  check('user queue + autoplay kept after steered', JSON.stringify(upcoming(q).slice(5)) === JSON.stringify(['user1', 'auto1', 'auto2']));
  check('studio song chosen over live/UGC variants', steeredIds.every((v) => /^v\d+$/.test(v)), steeredIds.join(','));
  check('avoided artist filtered (Queen)', !steeredIds.includes('v1'));
  check('not-found song reported', (s.note || '').includes('Imaginary Song'), s.note);
  check('library artists sent to Claude as known', aiCalls[0].known_artists.includes('Led Zeppelin'), aiCalls[0].known_artists.join(','));
  const authed = ytHeaders.filter((h) => h.auth.startsWith('SAPISIDHASH '));
  check('innertube requests signed (SAPISIDHASH, authuser 1)', authed.length > 0 && authed.every((h) => h.authuser === '1'), `${authed.length}/${ytHeaders.length}`);
  const callsAfterFill = aiCalls.length;

  // ---- Song changes: no call until fewer than 3 ahead, then top up in order
  for (let i = 0; i < 2; i++) { await ytm.evaluate(() => window.__advance()); await sleep(3500); }
  s = await waitSteer((x) => x.status !== 'working');
  check('no Claude call while 3+ steered ahead', aiCalls.length === callsAfterFill, `calls ${aiCalls.length}`);
  check('playing steered song marked playing', s.items[0] && s.items[0].status === 'playing' && s.items[0].videoId === steeredIds[1], JSON.stringify(s.items.map((i) => [i.videoId, i.status])));
  await ytm.evaluate(() => window.__advance());
  s = await waitSteer((x) => x.status === 'ok' && x.items.filter((i) => i.status === 'queued').length === 5 && aiCalls.length > callsAfterFill, 40000);
  q = await queue();
  console.log('queue after top-up:', q.join(' '));
  const up = upcoming(q);
  check('top-up refills to 5 ahead', s.items.filter((i) => i.status === 'queued').length === 5);
  check('older picks stay first after top-up', JSON.stringify(up.slice(0, 2)) === JSON.stringify(steeredIds.slice(3, 5)), up.join(' '));
  check('user items still after steered', JSON.stringify(up.slice(5)) === JSON.stringify(['user1', 'auto1', 'auto2']), up.join(' '));
  check('no duplicate rows', new Set(q.map((x) => x.replace('*', ''))).size === q.length);
  const routes = await ytm.evaluate(() => window.__routes);
  const expectRoute = { behavior: 'behavior', click: 'click', event: 'event' }[MODE];
  check(`queue commands went through the ${MODE} route`, routes[expectRoute] > 0 && Object.entries(routes).every(([k, v]) => k === expectRoute || v === 0), JSON.stringify(routes));
  check('already queued sent to Claude', aiCalls[aiCalls.length - 1].already_queued.length === 2);

  // ---- Remove one with X
  const callsBefore = aiCalls.length;
  const victim = s.items.find((i) => i.status === 'queued');
  await panel.click(`button[aria-label="Remove ${victim.title} from the queue"]`);
  await sleep(2500);
  s = await waitSteer((x) => x.status !== 'working');
  q = await queue();
  check('X removes from YTM queue', !q.some((x) => x.replace('*', '') === victim.videoId), q.join(' '));
  check('X removes from panel list', !s.items.some((i) => i.videoId === victim.videoId));
  check('removed song goes on skip list', (s.skip || []).some((k) => k.title === victim.title && k.why === 'removed'));
  check('no Claude call when 4 still ahead', aiCalls.length === callsBefore);

  // ---- Thumbs down
  const bad = s.items.find((i) => i.status === 'queued');
  await panel.click(`button[aria-label="Thumbs down ${bad.title}"]`);
  await sleep(2500);
  s = await waitSteer((x) => x.status !== 'working');
  const dislikes = await panel.evaluate(() => chrome.storage.local.get('dislikes').then((x) => x.dislikes || []));
  q = await queue();
  check('thumbs-down adds to dislikes', dislikes.some((d) => d.title === bad.title));
  check('thumbs-down removes from queue', !q.some((x) => x.replace('*', '') === bad.videoId));
  await panel.click('summary:has-text("Disliked")');
  await panel.locator('#dislikeList input').first().fill('too slow');
  await sleep(800);
  const d2 = await panel.evaluate(() => chrome.storage.local.get('dislikes').then((x) => x.dislikes));
  check('dislike reason saved', d2[0].reason === 'too slow');
  // Next call should carry the dislike + reason. Snap change forces a call.
  const beforeSnap = s.items.filter((i) => i.status === 'queued').map((i) => i.videoId);
  const callsSnap = aiCalls.length;
  await panel.locator('#slider-energy').fill('20');
  s = await waitSteer((x) => x.status === 'ok' && aiCalls.length > callsSnap && x.items.filter((i) => i.status === 'queued').length === 5, 40000);
  q = await queue();
  const last = aiCalls[aiCalls.length - 1];
  check('snap change replaces unplayed steered songs', beforeSnap.every((v) => !q.some((x) => x.replace('*', '') === v)), upcoming(q).join(' '));
  check('snap change sends new energy', last.controls.energy.value === 20);
  check('dislike + reason sent to Claude', last.disliked.some((d) => d.title === bad.title && d.reason === 'too slow'));
  check('removed song sent as skipped', last.skipped.some((k) => k.title === victim.title));

  // ---- Gradual drift
  await panel.click('.seg label:has(input[value=gradual])');
  await panel.fill('#driftSongs', '4'); await panel.locator('#driftSongs').dispatchEvent('change');
  await sleep(2500);
  const callsG = aiCalls.length;
  const queuedBeforeG = (await steerState()).items.filter((i) => i.status === 'queued').map((i) => i.videoId);
  await panel.locator('#slider-energy').fill('100');
  await sleep(4000);
  s = await waitSteer((x) => x.status !== 'working');
  const drift = await panel.evaluate(() => chrome.storage.local.get('drift').then((x) => x.drift));
  q = await queue();
  check('gradual change keeps queued steered songs', queuedBeforeG.every((v) => q.some((x) => x.replace('*', '') === v)));
  check('gradual change stores a drift from 20 over 4 songs', drift && drift.from.energy === 20 && drift.of === 4, JSON.stringify(drift && { e: drift.from.energy, of: drift.of }));
  check('gradual change makes no immediate call', aiCalls.length === callsG);
  // force a top-up via Refresh to see the drift in the payload
  await panel.click('#refresh');
  s = await waitSteer((x) => x.status === 'ok' && aiCalls.length > callsG, 40000);
  const gp = aiCalls[aiCalls.length - 1];
  // Energy blends from 20 toward 100 by songs played since the change (a song counts after 30 s of play).
  const expected = gp.drift ? Math.round(20 + (100 - 20) * (gp.drift.step / 4)) : null;
  check('drift info + blended energy sent', gp.drift && gp.drift.of === 4 && gp.drift.step < 4 && gp.controls.energy.value === expected,
    JSON.stringify({ drift: gp.drift, energy: gp.controls.energy.value, expected }));
  check('panel shows drift progress', !(await panel.locator('#driftStatus').isHidden()), await panel.textContent('#driftStatus'));

  // ---- Presets
  await panel.fill('#presetName', 'Heavy 70s');
  await panel.click('#presetSave button');
  await sleep(300);
  await panel.locator('#slider-tempo').fill('5');
  await sleep(500);
  await panel.selectOption('#presetSelect', 'Heavy 70s');
  await panel.click('#presetLoad');
  await sleep(800);
  const ctl = await panel.evaluate(() => chrome.storage.local.get('controls').then((x) => x.controls));
  check('preset load restores controls', ctl.tempo === 50 && ctl.energy === 100, `tempo ${ctl.tempo} energy ${ctl.energy}`);

  // ---- Steering off stops touching the queue
  await panel.click('.switch');
  await sleep(500);
  const callsOff = aiCalls.length;
  for (let i = 0; i < 4; i++) { await ytm.evaluate(() => window.__advance()); await sleep(1200); }
  await sleep(3500);
  check('steering off: no more calls', aiCalls.length === callsOff);
  check('status says steering off', (await panel.textContent('#steerStatus')).includes('Steering is off'));

  await panel.click('.switch');
  await sleep(500);
  await sleep(6000);
  if (process.env.SCREENSHOT) await panel.screenshot({ path: process.env.SCREENSHOT });
  check(`requests went only to ${PROVIDER}`, providerHits[PROVIDER] === aiCalls.length && providerHits[PROVIDER === 'gemini' ? 'anthropic' : 'gemini'] === 0, JSON.stringify(providerHits));
  if (PROVIDER === 'gemini') {
    check('Gemini request shape (key header, JSON schema)', geminiShapeOk);
    check('busy default model falls back to the next free model', geminiModels[0] === 'gemini-3.8-flash' && geminiModels[1] === 'gemini-3.6-flash', geminiModels.slice(0, 3).join(' → '));
  }
  check('usage line names the provider', (await panel.textContent('#callInfo')).startsWith(PROVIDER === 'gemini' ? 'Gemini calls' : 'Claude calls'), await panel.textContent('#callInfo'));
  check('no page errors', errors.length === 0, errors.join(' | '));
  console.log(`${PROVIDER} calls total:`, aiCalls.length, '| queue events:', (await ytm.evaluate(() => window.__events.length)));
  const failures = results.filter((r) => r[0] === 'FAIL').length;
  console.log(failures, 'failures');
  await ctx.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
