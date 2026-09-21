(() => {
  if (typeof window.acquireVsCodeApi === 'function') return;

  const port = window.__AURA_BROWSER_PORT__ || location.port;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.hostname || '127.0.0.1'}:${port}/ws`;
  const queue = [];
  let ws = null;
  let retryMs = 500;
  let hasOpened = false;

  function fileUrl(localPath) {
    return localPath ? `/api/files?p=${encodeURIComponent(localPath)}` : '';
  }

  function patchPayload(payload) {
    const seen = new WeakSet();
    const patchOne = (obj) => {
      if (!obj || typeof obj !== 'object' || seen.has(obj)) return obj;
      seen.add(obj);
      if (obj.localPath && (!obj.webviewUri || String(obj.webviewUri).startsWith('vscode-'))) {
        obj.webviewUri = fileUrl(obj.localPath);
      }
      for (const value of Object.values(obj)) {
        if (Array.isArray(value)) value.forEach(patchOne);
        else patchOne(value);
      }
      return obj;
    };
    return patchOne(payload);
  }

  function emit(data) {
    if (data && data.payload) patchPayload(data.payload);
    if (data && data.data) patchPayload(data.data);
    window.dispatchEvent(new MessageEvent('message', { data }));
  }

  function reply(requestId, data) {
    if (!requestId) return;
    emit({ type: 'reply', requestId, data });
  }

  function setBrowserProxyStatus(ready) {
    emit({ type: 'proxy.status', payload: { ready, port } });
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      const reconnecting = hasOpened;
      retryMs = 500;
      hasOpened = true;
      setBrowserProxyStatus(true);
      if (reconnecting) emit({ type: 'state.invalidate', payload: { scope: 'activeChat' } });
      while (queue.length && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(queue.shift()));
      }
    });
    ws.addEventListener('message', (evt) => {
      try { emit(JSON.parse(evt.data)); }
      catch (e) { console.warn('[aura-browser] bad websocket message', e); }
    });
    ws.addEventListener('close', () => {
      setBrowserProxyStatus(false);
      setTimeout(connect, retryMs);
      retryMs = Math.min(5000, retryMs * 1.7);
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  }

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'openExternal') {
        const url = msg.payload && msg.payload.url;
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        reply(msg.requestId, { ok: true });
        return;
      }
      if (msg.type === 'attach.pickFromHost' || msg.type === 'attach.pickFromHostPath') {
        reply(msg.requestId, { cancelled: true });
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      } else if (!hasOpened) {
        queue.push(msg);
      } else {
        reply(msg.requestId, { error: 'Browser bridge is reconnecting. Please wait for proxy to reconnect, then send again.' });
      }
    },
    getState() { return null; },
    setState() {},
  });

  connect();
})();
