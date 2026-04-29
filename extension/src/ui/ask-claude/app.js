// Unofficial FortiMonitor Toolkit - Ask AI (FMN-53 / FMN-120) UI
// Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
//
// Thin chat UI. Sends user turns to the service worker ('chat:send'),
// listens for 'chat:event' broadcasts to render streaming text and
// tool-call activity, shows the final assistant message when the loop
// settles. Provider-aware: Anthropic / Ollama / LM Studio.

import {
  getAskClaudeProvider,
  getAskClaudeProviderConfig
} from '../../lib/settings.js';

const PANOPTA_KEY = 'panopta.apiKey';
const CLAUDE_KEY = 'claude.apiKey';

const PROVIDER_LABEL = {
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  lmstudio: 'LM Studio'
};

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
  setupWarningText: document.getElementById('setup-warning-text'),
  providerIndicator: document.getElementById('provider-indicator'),
  costWarningAnthropic: document.getElementById('cost-warning-anthropic'),
  costWarningLocal: document.getElementById('cost-warning-local'),
  localModelTip: document.getElementById('local-model-tip')
};

// ---- Preflight: make sure auth for the active provider is configured -------

async function preflight() {
  const provider = await getAskClaudeProvider();
  applyProviderUi(provider);
  const data = await chrome.storage.local.get([PANOPTA_KEY, CLAUDE_KEY]);
  const missing = [];
  if (!data?.[PANOPTA_KEY]) missing.push('FortiMonitor RW API key');
  if (provider === 'anthropic') {
    if (!data?.[CLAUDE_KEY]) missing.push('Anthropic API key');
  } else {
    const cfg = await getAskClaudeProviderConfig(provider);
    if (!cfg.url) missing.push(`${PROVIDER_LABEL[provider]} base URL`);
    if (!cfg.model) missing.push(`${PROVIDER_LABEL[provider]} model`);
  }
  if (missing.length === 0) {
    els.setupWarning.hidden = true;
    return true;
  }
  els.setupWarningText.textContent = ` Missing: ${missing.join(' and ')}. `;
  els.setupWarning.hidden = false;
  setSending(false);
  return false;
}

function applyProviderUi(provider) {
  if (els.providerIndicator) {
    const label = PROVIDER_LABEL[provider] ?? provider;
    els.providerIndicator.textContent = `Provider: ${label}`;
    els.providerIndicator.hidden = false;
  }
  if (els.costWarningAnthropic) {
    els.costWarningAnthropic.hidden = provider !== 'anthropic';
  }
  if (els.costWarningLocal) {
    els.costWarningLocal.hidden = provider === 'anthropic';
  }
  if (els.localModelTip) {
    els.localModelTip.hidden = provider === 'anthropic';
  }
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
    // loop_end stops the thinking clock and replaces it with the
    // outcome line. Include total elapsed seconds so the operator
    // can see how long the turn took even after it's done.
    const totalElapsed = thinkingStartMs != null
      ? Math.floor((Date.now() - thinkingStartMs) / 1000)
      : null;
    const elapsedSuffix = totalElapsed != null ? ` in ${formatElapsed(totalElapsed)}` : '';
    stopThinkingClock(`done (${ev.reason}, ${ev.iterations} turn${ev.iterations === 1 ? '' : 's'}${elapsedSuffix})`);
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

// FMN-120 followup: thinking indicator with a ticking elapsed-time
// counter. Local providers can take 30-180s on a cold model load;
// without feedback the operator can't tell whether the chat is
// progressing or stuck. Tick once per second while a turn is in
// flight and clear the timer when the loop ends or the user aborts.
let thinkingTimer = null;
let thinkingStartMs = null;

function startThinkingClock() {
  stopThinkingClock();
  thinkingStartMs = Date.now();
  setStatus('thinking… (0s)');
  thinkingTimer = setInterval(() => {
    if (thinkingStartMs == null) return;
    const elapsed = Math.floor((Date.now() - thinkingStartMs) / 1000);
    setStatus(`thinking… (${formatElapsed(elapsed)})`);
  }, 1000);
}

function stopThinkingClock(finalText = '') {
  if (thinkingTimer != null) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
  thinkingStartMs = null;
  if (finalText !== null) setStatus(finalText);
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
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
  startThinkingClock();

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'chat:send',
      payload: { messages: state.messages }
    });
    if (!res) {
      stopThinkingClock('');
      appendMessage('error', 'No response from service worker.');
      return;
    }
    if (!res.ok) {
      stopThinkingClock('');
      appendMessage('error', `Error: ${res.error ?? 'unknown'}`);
      return;
    }
    // Sync the canonical message list from the service-worker run. The
    // loop_end event already updated the status to "done (...)"; we
    // don't override it here.
    state.messages = res.result.messages;
  } catch (err) {
    stopThinkingClock('');
    appendMessage('error', `Error: ${err?.message ?? err}`);
  } finally {
    setSending(false);
  }
}

async function abort() {
  try {
    await chrome.runtime.sendMessage({ type: 'chat:abort', payload: {} });
    stopThinkingClock('aborted');
  } catch { /* ignore */ }
}

function reset() {
  state.messages = [];
  els.messages.innerHTML = '';
  toolCallEls.clear();
  stopThinkingClock('');
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

// Self-heal the setup-needed banner when keys are saved in the popup or
// when the tab comes back to the foreground after configuring elsewhere.
// FMN-120: also re-run preflight when the operator switches providers or
// edits the local-provider URL/model from Settings.
const PROVIDER_KEYS = [
  'fm:askClaudeProvider',
  'fm:askClaudeOllamaUrl',
  'fm:askClaudeOllamaModel',
  'fm:askClaudeLmStudioUrl',
  'fm:askClaudeLmStudioModel'
];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[PANOPTA_KEY] || changes[CLAUDE_KEY]) { preflight(); return; }
  for (const k of PROVIDER_KEYS) {
    if (changes[k]) { preflight(); return; }
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) preflight();
});

preflight();
