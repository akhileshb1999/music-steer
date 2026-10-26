import { getApiKey, setApiKey } from '../lib/state.js';
import { testKey, MODEL } from '../lib/anthropic.js';

const keyInput = document.getElementById('key');
const status = document.getElementById('status');

function setStatus(msg, kind = '') {
  status.textContent = msg;
  status.className = `status ${kind}`;
}

keyInput.value = await getApiKey();

document.getElementById('show').addEventListener('click', (e) => {
  const hidden = keyInput.type === 'password';
  keyInput.type = hidden ? 'text' : 'password';
  e.target.textContent = hidden ? 'Hide' : 'Show';
});

document.getElementById('save').addEventListener('click', async () => {
  await setApiKey(keyInput.value.trim());
  setStatus(keyInput.value.trim() ? 'Saved.' : 'Saved (empty).', 'ok');
});

document.getElementById('clear').addEventListener('click', async () => {
  keyInput.value = '';
  await setApiKey('');
  setStatus('Key removed.', 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  const key = keyInput.value.trim();
  if (!key) return setStatus('Enter a key first.', 'error');
  setStatus('Testing…');
  try {
    const r = await testKey(key);
    if (r.ok) setStatus(`Key works and has access to ${MODEL}. Remember to Save.`, 'ok');
    else setStatus(`Key test failed: ${r.message}`, 'error');
  } catch (err) {
    setStatus(`Could not reach api.anthropic.com: ${err.message}`, 'error');
  }
});
