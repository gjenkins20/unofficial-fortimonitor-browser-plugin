// Unofficial FortiMonitor Toolkit — Ask Claude (FMN-53) UI
// Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
//
// Thin chat UI. Sends user turns to the service worker ('chat:send'),
// listens for 'chat:event' broadcasts to render streaming text and
// tool-call activity, shows the final assistant message when the loop
// settles.

const PANOPTA_KEY = 'panopta.apiKey';
const CLAUDE_KEY = 'claude.apiKey';

const state = {
  messages: [], // message objects sent to the API ({role, content})
  running: false,
  currentAssistantEl: null
};

const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('composer-input'),
  sendBtn: document.getElementById('send-btn'),
  abortBtn: document.getElementById('abort-btn'),
  resetBtn: document.getElementById('reset-btn'),
  status: document.getElementById('status-text'),
  setupWarning: document.getElementById('setup-warning'),
  setupWarningText: document.getElementById('setup-warning-text')
};

// ---- Preflight: make sure both keys are configured --------------------------

async function preflight() {
  const data = await chrome.storage.local.get([PANOPTA_KEY, CLAUDE_KEY]);
  const missing = [];
  if (!data?.[PANOPTA_KEY]) missing.push('FortiMonitor RW API key');
  if (!data?.[CLAUDE_KEY]) missing.push('Anthropic (Claude) API key');
  if (missing.length === 0) {
    els.setupWarning.hidden = true;
    return true;
  }
  els.setupWarningText.textContent = ` Missing: ${missing.join(' and ')}. `;
  els.setupWarning.hidden = false;
  setSending(false);
  return false;
}

// ---- Rendering --------------------------------------------------------------

function appendMessage(kind, text = '') {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return el;
}

function appendToolCallEl(name, input) {
  const el = document.createElement('div');
  el.className = 'msg tool';
  const header = document.createElement('div');
  header.innerHTML = `<span class="tool-name">⚙ ${escapeHtml(name)}</span>`;
  el.appendChild(header);
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = 'input';
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(input ?? {}, null, 2);
  det.appendChild(pre);
  el.appendChild(det);
  const statusLine = document.createElement('div');
  statusLine.className = 'tool-status';
  statusLine.textContent = 'running…';
  el.appendChild(statusLine);
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return { el, statusLine };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ---- Event handling ---------------------------------------------------------

const toolCallEls = new Map(); // tool_use id → { el, statusLine }

function handleChatEvent(ev) {
  if (!ev) return;

  if (ev.phase === 'turn' && ev.kind === 'block_start' && ev.block?.type === 'text') {
    state.currentAssistantEl = appendMessage('assistant', '');
  } else if (ev.phase === 'turn' && ev.kind === 'text') {
    if (!state.currentAssistantEl) {
      state.currentAssistantEl = appendMessage('assistant', '');
    }
    state.currentAssistantEl.textContent += ev.text;
    els.messages.scrollTop = els.messages.scrollHeight;
  } else if (ev.phase === 'turn' && ev.kind === 'block_stop' && ev.block?.type === 'text') {
    state.currentAssistantEl = null;
  } else if (ev.phase === 'tool_call_start') {
    const rec = appendToolCallEl(ev.name, ev.input);
    toolCallEls.set(ev.id, rec);
    state.currentAssistantEl = null;
  } else if (ev.phase === 'tool_call_result') {
    const rec = toolCallEls.get(ev.id);
    if (rec) {
      rec.statusLine.textContent = ev.isError ? 'error' : 'done';
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = ev.isError ? 'error detail' : 'result';
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = typeof ev.result === 'string'
        ? ev.result
        : JSON.stringify(ev.result, null, 2);
      det.appendChild(pre);
      rec.el.appendChild(det);
    }
  } else if (ev.phase === 'loop_end') {
    setStatus(`done (${ev.reason}, ${ev.iterations} turn${ev.iterations === 1 ? '' : 's'})`);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === '__event__' && msg.event === 'chat:event') {
    handleChatEvent(msg.payload);
  }
});

// ---- Send ------------------------------------------------------------------

function setSending(isSending) {
  state.running = isSending;
  els.sendBtn.disabled = isSending;
  els.input.disabled = isSending;
  els.abortBtn.hidden = !isSending;
}

function setStatus(text) {
  els.status.textContent = text ?? '';
}

async function send() {
  const ok = await preflight();
  if (!ok) return;

  const text = els.input.value.trim();
  if (!text) return;

  appendMessage('user', text);
  state.messages.push({ role: 'user', content: text });
  els.input.value = '';
  setSending(true);
  setStatus('thinking…');

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'chat:send',
      payload: { messages: state.messages }
    });
    if (!res) {
      appendMessage('error', 'No response from service worker.');
      return;
    }
    if (!res.ok) {
      appendMessage('error', `Error: ${res.error ?? 'unknown'}`);
      return;
    }
    // Sync the canonical message list from the service-worker run.
    state.messages = res.result.messages;
  } catch (err) {
    appendMessage('error', `Error: ${err?.message ?? err}`);
  } finally {
    setSending(false);
  }
}

async function abort() {
  try {
    await chrome.runtime.sendMessage({ type: 'chat:abort', payload: {} });
    setStatus('aborted');
  } catch { /* ignore */ }
}

function reset() {
  state.messages = [];
  els.messages.innerHTML = '';
  toolCallEls.clear();
  setStatus('');
}

els.sendBtn.addEventListener('click', send);
els.abortBtn.addEventListener('click', abort);
els.resetBtn.addEventListener('click', reset);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    send();
  }
});

preflight();
