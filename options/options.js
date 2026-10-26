import { getAiSettings, setAiSettings } from '../lib/state.js';
import { testKey, providerName } from '../lib/llm.js';
import { DEFAULT_GEMINI_MODEL } from '../lib/gemini.js';
import { MODEL as CLAUDE_MODEL } from '../lib/anthropic.js';

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = '') {
  $('status').textContent = msg;
  $('status').className = `status ${kind}`;
}

const settings = await getAiSettings();
$('geminiKey').value = settings.geminiKey;
$('anthropicKey').value = settings.apiKey;
$('geminiModel').value = settings.geminiModel;
$('geminiModel').placeholder = DEFAULT_GEMINI_MODEL;
document.querySelector(`input[name=provider][value=${settings.provider}]`).checked = true;

function current() {
  return {
    provider: document.querySelector('input[name=provider]:checked').value,
    geminiKey: $('geminiKey').value.trim(),
    apiKey: $('anthropicKey').value.trim(),
    geminiModel: $('geminiModel').value.trim()
  };
}

function showProvider() {
  const p = current().provider;
  $('geminiBox').hidden = p !== 'gemini';
  $('anthropicBox').hidden = p !== 'anthropic';
  setStatus('');
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  $('saved').textContent = 'Saving…';
  saveTimer = setTimeout(async () => {
    await setAiSettings(current());
    $('saved').textContent = 'Saved';
  }, 300);
}

document.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', () => { showProvider(); save(); }));
for (const id of ['geminiKey', 'anthropicKey', 'geminiModel']) $(id).addEventListener('input', save);

document.querySelectorAll('button.show').forEach((b) => b.addEventListener('click', () => {
  const input = $(b.dataset.for);
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  b.textContent = hidden ? 'Hide' : 'Show';
}));

$('test').addEventListener('click', async () => {
  const s = current();
  const key = s.provider === 'anthropic' ? s.apiKey : s.geminiKey;
  if (!key) return setStatus(`Paste your ${providerName(s)} API key first.`, 'error');
  setStatus('Testing…');
  try {
    const r = await testKey(s);
    const model = s.provider === 'anthropic' ? CLAUDE_MODEL : (s.geminiModel || DEFAULT_GEMINI_MODEL);
    if (r.ok) setStatus(`Works: the key has access to ${model}. You're all set.`, 'ok');
    else setStatus(`Test failed: ${r.message.replace(' Check it in Options.', '')}`, 'error');
  } catch (err) {
    setStatus(`Couldn't reach ${providerName(s)}: ${err.message}`, 'error');
  }
});

showProvider();
