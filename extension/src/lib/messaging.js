// Unofficial FortiMonitor Toolkit — Gregori Jenkins <https://www.linkedin.com/in/gregorijenkins>
// Thin wrapper around chrome.runtime.sendMessage so step modules don't
// have to juggle the { ok, result, error } envelope or the two-arg
// callback signature. All errors surface as thrown Errors.

export function call(type, payload = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        settled = true;
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(lastError.message));
        if (!response) return reject(new Error('No response from service worker'));
        if (!response.ok) return reject(new Error(response.error || 'Request failed'));
        resolve(response.result);
      });
    } catch (err) {
      if (!settled) reject(err);
    }
  });
}

/**
 * Subscribe to service-worker-broadcast events. Returns an unsubscribe fn.
 * The service worker sends { type: '__event__', event, payload }.
 */
export function onEvent(handler) {
  const listener = (message) => {
    if (message && message.type === '__event__' && typeof message.event === 'string') {
      handler(message.event, message.payload);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
