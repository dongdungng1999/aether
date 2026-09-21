/**
 * AURA Studio — front-end controller (vanilla JS).
 *
 * Talks to the extension host via vscode.postMessage.
 *   - rpc(type, payload)     → returns Promise<reply.data>
 *   - host broadcasts:
 *       state.invalidate { scope: 'projects'|'chats' }
 *       chat.start  { chatId }
 *       chat.chunk  { chatId, evt: { event, data } }   ← raw Anthropic SSE event
 *       chat.done   { chatId, stopReason, usage, costUsd }
 *       chat.error  { chatId, error }
 *
 * Streaming uses RAF batching: chunks accumulate into a pending buffer and
 * flush at most once per animation frame, so many small text_deltas don't
 * thrash the layout engine.
 */

(() => {
  const vscode = acquireVsCodeApi();

  /** 0.4.419 — the browser bridge injects window.__AURA_BROWSER_PORT__.
   *  When present we're the Cloudflare/browser client: host controls that
   *  run native VS Code UI (build/purge/file pickers/preset editor) are
   *  hidden — the backend also refuses them for this origin. */
  const IS_BROWSER = typeof window.__AURA_BROWSER_PORT__ !== 'undefined';

  /* ── RPC ────────────────────────────────────────────────────────── */
  const pending = new Map();
  /** Per-message timeouts. chat.send may run a long tool loop (image gen,
   *  long bash) — give it 10 minutes so users don't see phantom RPC errors
   *  while a real reply is on the way. The host always sends back a final
   *  reply (success or error), so cancellation isn't a leak. */
  const RPC_TIMEOUTS = {
    'chat.send':           600_000,
    'chat.resume':         600_000,  // v0.2.18 — outer loop can run long in Dev Mode
    'agents.forceReturn':  600_000,  // force-return can trigger a subtree re-run
    'agents.chat':          600_000,  // manual agent chat turn — one model call
    'agents.submit':         30_000,   // one-edge submit — no model call
    'agents.summarize':     600_000,  // one inference turn per agent — can be long
    'agents.summarizeAll':  1800_000, // batch summarize all agents — up to 30m
    'agents.submitAll':     1800_000, // full bottom-up propagation pipeline
    'file.readAsDataUri':   30_000,
    'file.preview':        300_000,  // MinerU parse for .docx/.xlsx/.pptx can take 30–120s
    'file.saveAs':         300_000,
    'artifacts.list':       30_000,
    'artifacts.pin':        300_000,
    'host.action':          600_000,  // build image / purge can run for minutes
    'host.connect':          60_000,
    'host.pickEnvFile':     600_000,  // waits on the native file dialog
    'host.presetReset':      60_000,  // waits on the native confirm dialog
  };
  function rpc(type, payload) {
    const requestId = Math.random().toString(36).slice(2, 10);
    const ms = RPC_TIMEOUTS[type] ?? 120_000;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      vscode.postMessage({ type, requestId, payload });
      setTimeout(() => {
        if (pending.has(requestId)) { pending.delete(requestId); reject(new Error(`RPC timeout: ${type}`)); }
      }, ms);
    });
  }

  /** v0.4.300 — fire-and-forget log to the extension OUTPUT channel so we
   *  can trace the artifact reload flow without DevTools. Remove once the
   *  session-switch artifact bug is closed. */
  function dbg(msg) {
    try { vscode.postMessage({ type: 'debug.log', requestId: 'dbg' + Math.random().toString(36).slice(2, 6), payload: { msg: String(msg) } }); } catch {}
    try { console.log('[art]', msg); } catch {}
  }

  /* ── DOM ────────────────────────────────────────────────────────── */
  const $ = (s) => document.querySelector(s);
  const els = {
    body:           document.body,
    newChatBtn:     $('#newChatBtn'),
    newProjectBtn:  $('#newProjectBtn'),
    settingsBtn:    $('#settingsBtn'),
    topGearBtn:     $('#topGearBtn'),
    topExportBtn:   $('#topExportBtn'),
    topExportHtmlBtn: $('#topExportHtmlBtn'),
    topCompactBtn:  $('#topCompactBtn'),
    topSpBtn:       $('#topSpBtn'),
    artifactGalleryBtn: $('#artifactGalleryBtn'),
    mineruPanelBtn: $('#mineruPanelBtn'),
    artifactGalleryBadge: $('#artifactGalleryBadge'),
    artifactGallery: $('#artifactGallery'),
    artifactGalleryClose: $('#artifactGalleryClose'),
    artifactGallerySort: $('#artifactGallerySort'),
    artifactGalleryList: $('#artifactGalleryList'),
    artifactGallerySub: $('#artifactGallerySub'),
    settingsBack:   $('#settingsBack'),
    settings:       $('#settings'),
    main:           $('#main'),
    workspaceShell: $('#workspaceShell'),
    researchPane:   $('#researchPane'),
    codingPane:     $('#codingPane'),
    workspaceSplitter: $('#workspaceSplitter'),
    workspaceSplitToggle: $('#workspaceSplitToggle'),
    workspaceLayoutPicker: $('#workspaceLayoutPicker'),
    recentList:     $('#recentList'),
    recentSelectToggle: $('#recentSelectToggle'),
    recentSelectBar:    $('#recentSelectBar'),
    recentSelectCount:  $('#recentSelectCount'),
    recentSelectAll:    $('#recentSelectAll'),
    recentSelectDelete: $('#recentSelectDelete'),
    recentSelectCancel: $('#recentSelectCancel'),
    projectList:    $('#projectList'),
    projectLabel:   $('#projectLabel'),
    modeResearch:   $('#modeResearch'),
    modeCoding:     $('#modeCoding'),
    codingPanel:    $('#codingPanel'),
    terminalSessions: $('#terminalSessions'),
    thread:         $('#thread'),
    terminalViewport: $('#terminalViewport'),
    terminalSplitter: $('#terminalSplitter'),
    terminalInput: $('#terminalInput'),
    terminalTargetLabel: $('#terminalTargetLabel'),
    terminalNewBtn: $('#terminalNewBtn'),
    terminalRefreshBtn: $('#terminalRefreshBtn'),
    terminalSendBtn: $('#terminalSendBtn'),
    terminalCloseBtn: $('#terminalCloseBtn'),
    terminalCtrlCBtn: $('#terminalCtrlCBtn'),
    terminalEscBtn: $('#terminalEscBtn'),
    terminalKillBtn: $('#terminalKillBtn'),
    modelPicker:    $('#modelPicker'),
    modelUnavailableBtn: $('#modelUnavailableBtn'),
    thinkingPicker: $('#thinkingPicker'),
    tempSlider:     $('#tempSlider'),
    tempValue:      $('#tempValue'),
    tempPreset:     $('#tempPreset'),
    proxyPill:      $('#proxyPill'),
    layoutWidthToggle: $('#layoutWidthToggle'),
    fontStylePicker: $('#fontStylePicker'),
    threadInner:    $('#threadInner'),
    composerInput:  $('#composerInput'),
    sendBtn:        $('#sendBtn'),
    splitter:       $('#splitter'),
    railCollapseBtn: $('#railCollapseBtn'),
    railExpandTab:   $('#railExpandTab'),
    composer:        $('#composer'),
    composerStatusRow: $('#composerStatusRow'),
    artifactStatusPill: $('#artifactStatusPill'),
    agentMonitor:    $('#agentMonitor'),
    agentDockHead:        $('#agentDockHead'),
    agentDockCount:       $('#agentDockCount'),
    agentDockCollapseBtn: $('#agentDockCollapseBtn'),
    agentDock:            $('#agentDock'),
    agentThreadBar:  $('#agentThreadBar'),
    agentBackBtn:    $('#agentBackBtn'),
    agentBreadcrumb: $('#agentBreadcrumb'),
    agentCancelBtn:  $('#agentCancelBtn'),
    agentResumeBtn:  $('#agentResumeBtn'),
    agentSubmitBtn:    $('#agentSubmitBtn'),
    agentSubmitStatus: $('#agentSubmitStatus'),
    agentSummarizeStatus: $('#agentSummarizeStatus'),
    agentResumeAllBtn: $('#agentResumeAllBtn'),
    agentSummaryAllBtn: $('#agentSummaryAllBtn'),
    agentSubmitAllBtn:  $('#agentSubmitAllBtn'),
    agentPropagationStatus: $('#agentPropagationStatus'),

    /* artifact panel (v0.2.10) */
    artifactPanel:    $('#artifactPanel'),
    artifactSplitter: $('#artifactSplitter'),
    artifactClose:    $('#artifactClose'),
    artifactTabs:     $('#artifactTabs'),
    artifactBody:     $('#artifactBody'),

    /* project view (Issue #3) */
    projectView:        $('#projectView'),
    projectTitle:       $('#projectTitle'),
    projectBack:        $('#projectBack'),
    projectRename:      $('#projectRename'),
    projectDelete:      $('#projectDelete'),
    projectDescEditor:  $('#projectDescEditor'),
    projectDescSave:    $('#projectDescSave'),
    projectDescStatus:  $('#projectDescStatus'),
    projectNewChat:     $('#projectNewChat'),
    projectChatList:    $('#projectChatList'),
    projectChatSelectToggle: $('#projectChatSelectToggle'),
    projectChatSelectBar:    $('#projectChatSelectBar'),
    projectChatSelCount:     $('#projectChatSelCount'),
    projectChatSelectAll:    $('#projectChatSelectAll'),
    projectChatSelectDelete: $('#projectChatSelectDelete'),
    projectChatSelectCancel: $('#projectChatSelectCancel'),
  };

  /* ── State ──────────────────────────────────────────────────────── */
  const THINKING_LABELS = ['Thinking', 'Pondering', 'Considering', 'Reflecting', 'Mulling', 'Reasoning', 'Analyzing', 'Tinkering', 'Exploring', 'Contemplating', 'Processing', 'Deliberating'];
  let _mermaidIdSeq = 0;

  const state = {
    projects: [],
    chats:    [],
    activeProjectId: null,
    activeChatId:    null,
    /** which "page" the main area is showing: 'chat' | 'project' | 'settings'
     *  (settings is independent — overlays via z-index. project replaces chat.)
     *  We track this so chat.* events know whether to mutate visible DOM. */
    view: 'chat',
    mainMode: 'research',
    workspaceSplit: localStorage.getItem('auraStudio.workspaceSplit') === '1',
    workspaceLayout: localStorage.getItem('auraStudio.workspaceLayout') || 'research-left',
    workspaceSplitPct: Math.max(25, Math.min(75, Number(localStorage.getItem('auraStudio.workspaceSplitPct')) || 50)),
    terminal: { sessions: [], target: null, displayTarget: null, pollTimer: null, refreshTimer: null, hiddenShells: new Set(), shellBaselines: new Map(), lastData: '', resizeObserver: null, writeBuf: '', writeRaf: 0, fitRaf: 0 },
    theme: 'aura-dark',
    sessionCost: 0,           // running total since panel open
    /** Per-chat temperature override — Map<chatId, number>. The slider in the
     *  topbar writes here on input; loadChat reads from here first, then
     *  falls back to ChatRecord.temperature, then to the default 0.7. */
    perChatTemperature: new Map(),
    /** Per-chat streaming flag — Set<chatId>. Lets multiple chats stream in
     *  parallel (issue #2 in 0.2.13). Composer Send/Stop reflects whichever
     *  chat is ACTIVE; switching to a non-streaming chat re-enables Send. */
    streamingChats: new Set(),
    loadGen: 0,   // incremented on every loadChat; retries abort on mismatch
    pendingAttachments: [],   // [{ hash, filename, parsedMd, mimeType, sizeBytes, inlineHint }]
    artifactsByChat: new Map(),
    liveArtifactTimers: new Map(),
    artifactGalleryOpen: false,
    artifactGallerySort: localStorage.getItem('auraStudio.artifactGallerySort') || 'newest',
    /** Per-chat assistant pending state — Map<chatId, {wrap, body, statusEl, blocks, toolBuf, flushPending}>.
     *  Multiple chats can stream concurrently; only the ACTIVE chat's bubble
     *  is in the DOM, the others' DOM nodes live detached and reattach when
     *  the user switches back. */
    pendingAsstByChat: new Map(),
    /** Detached thread DOM per non-active streaming chat — keyed by chatId.
     *  When user switches AWAY from a streaming chat, we save threadInner's
     *  children here; when they return, we restore it. */
    detachedThreads: new Map(),
    /** 0.4.161 — set of chatIds currently inside a runContinuationLoop.
     *  Signals onAsstStart to tag the next bubble with .continuation-part
     *  so CSS visually merges it with the previous bubble. */
    continuationActive: new Set(),
    /** multi-select mode for the Recent rail — checkbox UI + bulk delete */
    recentSelectMode: false,
    recentSelectedIds: new Set(),
    /** same pattern, scoped to project view chat list (issue #4 in 0.2.12) */
    projectChatSelectMode: false,
    projectChatSelectedIds: new Set(),
    /** cached chat list for the active project — used to re-render after select toggle */
    projectChatsCache: [],
    lastContextPct: 0,
    ctxUsage: { system: 0, tools: 0, runtime: 0, total: 0, ctxMax: 0, pct: 0 },
    /** Agent monitor is keyed by root chat; child threads are read-only. */
    agentsByChat: new Map(),
    activeAgentId: null,
    /** Keep Main's real DOM nodes alive while inspecting a child. This avoids
     *  destroying in-flight stream nodes and the temporary dead-dock window
     *  caused by serialising/restoring threadInner.innerHTML. */
    agentMainThreadNodes: null,
    agentViewGen: 0,
    agentPendingBlocks: new Map(),
    agentToolEvents: new Map(),
    agentUsageById: new Map(),
    /** agentIds currently mid-forceReturn RPC — shows spinner on row */
    agentForceReturnPending: new Set(),
    /** true while agents.chat RPC is in-flight — disables Send and Submit */
    agentManualStreaming: false,
    /** agentIds with a pending submit RPC in-flight — disables per-row Submit */
    agentSubmitPending: new Set(),
    /** agentIds with a pending summarize RPC in-flight */
    agentSummarizePending: new Set(),
    /** true while summarizeAll/submitAll RPC is running */
    agentBatchRunning: false,
    activeAgentRunByChat: new Map(),
    agentPropagationByChat: new Map(),
    unavailableModels: new Set(),
    queuedByChat: new Map(),
  };
  /** Convenience accessor: pendingAsst for the ACTIVE chat. Used everywhere
   *  the old code wrote `state.pendingAsst`. Returns null if not streaming. */
  function getActivePendingAsst() {
    return state.activeChatId ? (state.pendingAsstByChat.get(state.activeChatId) ?? null) : null;
  }
  function setActivePendingAsst(v) {
    if (!state.activeChatId) return;
    if (v == null) state.pendingAsstByChat.delete(state.activeChatId);
    else state.pendingAsstByChat.set(state.activeChatId, v);
  }
  /** True iff the currently-visible chat is streaming. Drives Send/Stop UI. */
  function isActiveStreaming() {
    return !!state.activeChatId && state.streamingChats.has(state.activeChatId);
  }
  /** Update the composer button to match the ACTIVE chat's streaming state.
   *  Single button, two modes:
   *    idle      → arrow ↑   click = send
   *    streaming → square ■  click = stop
   *  Idempotent. Call after every chat switch + chat.streaming broadcast. */
  function refreshComposerButtons() {
    const streaming = isActiveStreaming();
    const agentStreaming = !!state.agentManualStreaming || !!state.agentBatchRunning;
    if (els.sendBtn) {
      els.sendBtn.classList.toggle('streaming', streaming);
      els.sendBtn.setAttribute('aria-label', streaming ? 'Stop generation' : 'Send message');
      els.sendBtn.title = streaming ? 'Stop generation' : 'Send (Enter)';
      els.sendBtn.innerHTML = streaming
        ? '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>'
        : '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 14V3M3 8l5-5 5 5"/></svg>';
      els.sendBtn.disabled = agentStreaming;
    }
  }

  /* ── Boot ───────────────────────────────────────────────────────── */
  async function boot() {
    // Bind UI handlers FIRST so the user can always type + see errors even if
    // storage init or RPC handshake fails. Previously bindUi() ran last — any
    // thrown RPC during boot left the panel inert (no Enter, no clicks).
    bindUi();
    setTheme('claude');                 // optimistic default
    applyReadableWidth(localStorage.getItem('auraStudio.readableWidth') === '1');
    applyFontStyle(localStorage.getItem('auraStudio.fontStyle') || 'source');
    applyWorkspaceLayout();

    let res;
    try { res = await rpc('app.ready'); }
    catch (e) { showFatalBanner(`Could not reach Aether host: ${e.message}`); return; }

    if (res && res.error) {
      showFatalBanner(`Aether host error: ${res.error}\n\nUsually means storage failed to open. Check VS Code → Output → Aether.`);
      return;
    }
    setTheme(res?.theme || 'claude');
    updateProxyPill(res?.proxy);
    if (state.workspaceSplit) setWorkspaceSplit(true);
    // Stash settings for the artifact panel + python_browser tool.
    window.__AURA_CFG__ = res?.cfg || { artifactPanel: 'auto', pyodideEnabled: true };
    if (window.__AURA_CFG__.artifactPanel === 'always') {
      // Auto-open empty panel so user knows the surface exists.
      try { openArtifactPanel(); } catch {}
    }

    // Best-effort — don't block UI if these fail. Await the Recent list so a
    // webview reload can repaint the active/latest chat instead of showing an
    // empty landing screen while history exists on disk.
    await Promise.all([
      refreshModelPicker().catch(e => console.warn('[studio] config.uiModels failed:', e)),
      refreshProjects().catch(e => console.warn('[studio] projects.list failed:', e)),
      refreshRecentChats().catch(e => console.warn('[studio] chats.recent failed:', e)),
    ]);
    // Pre-load highlight.js at boot so code blocks are syntax-coloured during
    // live streaming (highlightCodeBlocks lazy-loads it otherwise, causing the
    // first streamed response to show un-highlighted plain text).
    loadVendorScript('highlight.min.js').catch(() => {});

    bindCrossWindowRefresh();

    const bootChatId = res?.activeChatId || state.chats[0]?.id;
    if (bootChatId) loadChat(bootChatId).catch(e => console.warn('[studio] boot loadChat failed:', e));
    // Ask the host which chats are currently mid-stream (panel re-open after
    // a chat got started in another window). Prevents Send→Stop from being
    // out of sync.
    refreshActiveStreamingState().catch(() => { /* best-effort */ });
  }

  function applyReadableWidth(on) {
    document.body.classList.toggle('readable-width', !!on);
    els.layoutWidthToggle?.classList.toggle('is-active', !!on);
    if (els.layoutWidthToggle) els.layoutWidthToggle.title = on ? 'Use full width' : 'Use readable width';
  }

  function applyFontStyle(style) {
    const value = ['source', 'charter', 'literata', 'sans'].includes(style) ? style : 'source';
    document.body.dataset.fontStyle = value;
    if (els.fontStylePicker) els.fontStylePicker.value = value;
  }

  function codingPaneVisible() {
    return !!state.workspaceSplit || state.mainMode === 'coding';
  }

  function isVerticalWorkspaceLayout() {
    return /-top$/.test(state.workspaceLayout || '');
  }

  function applyWorkspaceLayout() {
    const layout = ['research-left', 'coding-left', 'research-top', 'coding-top'].includes(state.workspaceLayout)
      ? state.workspaceLayout
      : 'research-left';
    state.workspaceLayout = layout;
    const split = !!state.workspaceSplit;
    const pct = Math.max(25, Math.min(75, Number(state.workspaceSplitPct) || 50));
    state.workspaceSplitPct = pct;
    els.body?.classList.toggle('workspace-split', split);
    els.workspaceShell?.classList.toggle('is-split', split);
    els.workspaceShell?.classList.toggle('is-vertical', isVerticalWorkspaceLayout());
    if (els.workspaceShell) {
      els.workspaceShell.dataset.layout = layout;
      els.workspaceShell.dataset.focus = state.mainMode === 'coding' ? 'coding' : 'research';
      els.workspaceShell.style.setProperty('--workspace-split-pct', `${pct}%`);
    }
    if (els.workspaceSplitter) {
      els.workspaceSplitter.hidden = !split;
      els.workspaceSplitter.setAttribute('aria-orientation', isVerticalWorkspaceLayout() ? 'horizontal' : 'vertical');
    }
    if (els.workspaceSplitToggle) {
      els.workspaceSplitToggle.classList.toggle('is-active', split);
      els.workspaceSplitToggle.setAttribute('aria-pressed', split ? 'true' : 'false');
      els.workspaceSplitToggle.title = split ? 'Unsplit Research and Coding' : 'Split Research and Coding';
    }
    if (els.workspaceLayoutPicker) {
      els.workspaceLayoutPicker.hidden = !split;
      els.workspaceLayoutPicker.value = layout;
    }
    if (codingPaneVisible() && state.terminal.term) setTimeout(() => terminalFit(), 80);
  }

  function setWorkspaceLayout(layout) {
    if (!['research-left', 'coding-left', 'research-top', 'coding-top'].includes(layout)) return;
    state.workspaceLayout = layout;
    localStorage.setItem('auraStudio.workspaceLayout', layout);
    applyWorkspaceLayout();
  }

  function setWorkspaceSplit(on) {
    state.workspaceSplit = !!on;
    localStorage.setItem('auraStudio.workspaceSplit', state.workspaceSplit ? '1' : '0');
    if (state.workspaceSplit) {
      if (els.thread) els.thread.hidden = false;
      if (els.composer) els.composer.hidden = false;
      if (els.codingPanel) els.codingPanel.hidden = false;
      const hasAgents = agentsForActiveChat().length;
      if (els.agentMonitor) els.agentMonitor.hidden = !hasAgents;
      terminalRefreshSessions().catch(e => terminalShowError(e));
      terminalStartRefresh();
    } else {
      setMainMode(state.mainMode || 'research');
    }
    applyWorkspaceLayout();
  }

  function setMainMode(mode) {
    const next = mode === 'coding' ? 'coding' : 'research';
    state.mainMode = next;
    const coding = next === 'coding';
    els.body?.classList.toggle('main-mode-coding', coding);
    els.body?.classList.toggle('main-mode-research', !coding);
    els.modeResearch?.classList.toggle('active', !coding);
    els.modeCoding?.classList.toggle('active', coding);
    if (state.workspaceSplit) {
      if (els.thread) els.thread.hidden = false;
      if (els.composer) els.composer.hidden = false;
      if (els.codingPanel) els.codingPanel.hidden = false;
      const hasAgents = agentsForActiveChat().length;
      if (els.agentMonitor) els.agentMonitor.hidden = !hasAgents;
      // Split mode only changes pane focus/layout. Do not refresh sessions here:
      // a transient tmux.list miss can clear the active PTY and make Coding look
      // reset when the user is merely swapping Research/Coding positions.
      terminalStartRefresh();
      applyWorkspaceLayout();
      return;
    }
    if (els.thread) els.thread.hidden = coding;
    if (els.agentMonitor) els.agentMonitor.hidden = coding || !agentsForActiveChat().filter(a => !a.released).length;
    if (els.composer) els.composer.hidden = coding;
    if (els.codingPanel) els.codingPanel.hidden = !coding;
    if (coding) {
      terminalRefreshSessions().catch(e => terminalShowError(e));
      terminalStartRefresh();
      setTimeout(() => terminalFit(), 80);
      setTimeout(() => terminalFit(), 260);
    } else {
      terminalStopPoll();
      terminalStopRefresh();
      if (state.terminal.ptyId) rpc('terminal.ptyClose', { id: state.terminal.ptyId }).catch(() => {});
      state.terminal.ptyId = null;
      state.terminal.target = null;
      state.terminal.displayTarget = null;
      state.terminal.lastData = '';
      clearTerminalWriteBuffer();
      state.terminal.term?.reset?.();
      if (els.codingPanel) els.codingPanel.hidden = true;
      if (els.thread) els.thread.hidden = false;
      if (els.composer) els.composer.hidden = false;
    }
    applyWorkspaceLayout();
  }

  function terminalShowError(e) {
    if (els.terminalViewport) els.terminalViewport.textContent = `terminal error: ${e?.message || e}`;
  }

  function terminalTargetsEqual(a, b) {
    return !!a && !!b && a.session === b.session && Number(a.window || 0) === Number(b.window || 0) && Number(a.pane || 0) === Number(b.pane || 0);
  }
  function terminalTargetKey(t) {
    return t ? `${t.session}:${Number(t.window || 0)}.${Number(t.pane || 0)}` : '';
  }

  function terminalVisibleSessions() {
    return (state.terminal.sessions || []).filter(s => {
      const name = String(s.name || '');
      return !/^aura_view_/i.test(name) && /aura/i.test(name) && !state.terminal.hiddenShells?.has?.(name);
    });
  }

  function terminalTargetsFromSessions(sessions) {
    return (sessions || []).flatMap(s => (s.windows || []).flatMap(w => (w.panes || []).map(p => p.target || { session: s.name, window: w.index, pane: p.index })));
  }

  async function terminalRefreshSessions(opts = {}) {
    const prevKeys = new Set(terminalTargetsFromSessions(terminalVisibleSessions()).map(terminalTargetKey));
    const r = await rpc('terminal.list');
    state.terminal.sessions = r.sessions || [];
    const rawTargets = terminalTargetsFromSessions(state.terminal.sessions || []);
    const displayExists = state.terminal.displayTarget && rawTargets.some(t => terminalTargetsEqual(t, state.terminal.displayTarget));
    if (state.terminal.displayTarget && !displayExists && /^aura-term-/i.test(String(state.terminal.target?.session || ''))) {
      state.terminal.hiddenShells.delete(state.terminal.target.session);
      state.terminal.displayTarget = null;
    }
    const visibleSessions = terminalVisibleSessions();
    const allTargets = terminalTargetsFromSessions(visibleSessions);
    const currentExists = state.terminal.target && rawTargets.some(t => terminalTargetsEqual(t, state.terminal.target));
    if (state.terminal.target && !currentExists) {
      if (state.terminal.ptyId) await rpc('terminal.ptyClose', { id: state.terminal.ptyId }).catch(() => {});
      state.terminal.ptyId = null;
      state.terminal.target = null;
      state.terminal.displayTarget = null;
      state.terminal.lastData = '';
      clearTerminalWriteBuffer();
      state.terminal.term?.reset?.();
    }
    const fresh = allTargets.find(t => !prevKeys.has(terminalTargetKey(t)));
    for (const [shellName, baseline] of state.terminal.shellBaselines.entries()) {
      if (state.terminal.hiddenShells.has(shellName)) continue;
      const replacement = fresh && !/^aura-term-/i.test(String(fresh.session || ''))
        ? fresh
        : terminalTargetsFromSessions((state.terminal.sessions || []).filter(s => {
            const name = String(s.name || '');
            return !/^aura-term-/i.test(name) && /aura/i.test(name) && !baseline.has(name);
          })).find(Boolean);
      if (!replacement) continue;
      state.terminal.hiddenShells.add(shellName);
      state.terminal.shellBaselines.delete(shellName);
      if (terminalTargetsEqual(state.terminal.target, { session: shellName, window: 0, pane: 0 }) || !state.terminal.displayTarget) {
        state.terminal.displayTarget = replacement;
      }
      state.terminal.sessions = (state.terminal.sessions || []).filter(s => s.name !== shellName);
    }
    renderTerminalSessions();
    if (!state.terminal.target && els.terminalTargetLabel) els.terminalTargetLabel.textContent = 'No terminal';
  }

  function terminalTargetText(t) {
    return t ? `${t.session}` : 'No terminal';
  }
  function pathBasename(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  }

  function renderTerminalSessions() {
    if (!els.terminalSessions) return;
    const sessions = terminalVisibleSessions();
    els.terminalSessions.innerHTML = sessions.map(s => {
      const panes = (s.windows || []).flatMap(w => (w.panes || []).map(p => ({ ...p, window: w.index })));
      const primary = panes[0];
      if (!primary) return '';
      const t = primary.target || { session: s.name, window: primary.window, pane: primary.index };
      const active = terminalTargetsEqual(t, state.terminal.displayTarget || state.terminal.target);
      const cmd = primary.currentCommand || 'bash';
      const closable = /^aura-term-/i.test(s.name);
      const title = closable ? `${cmd} ${pathBasename(primary.currentPath) || '~'}` : s.name;
      // Only extension-created terminals (aura-term-*) get a close button.
      // Infra sessions (aura-linux-*: proxy/mineru) must never be killed from
      // the sidebar — see host-crash safety rule. They vanish from the list
      // on their own when the underlying tmux session ends.
      const closeBtn = closable ? `<span class="terminal-tab-close" data-close-target='${escapeAttr(JSON.stringify(t))}' title="Close terminal">×</span>` : '';
      return `<button class="terminal-tab ${active ? 'active' : ''}" data-target='${escapeAttr(JSON.stringify(t))}' title="${escapeAttr(terminalTargetText(t))}"><span class="terminal-tab-title">${escapeHtml(title)}</span><span class="terminal-tab-cmd">${escapeHtml(cmd)}</span>${closeBtn}</button>`;
    }).join('') || '<span class="terminal-empty">No Aether terminals — press + to open one</span>';
  }

  async function terminalCreateAndOpen() {
    const name = `aura-term-${Date.now().toString(36)}`;
    state.terminal.hiddenShells.delete(name);
    state.terminal.shellBaselines.set(name, new Set(terminalVisibleSessions().filter(s => !/^aura-term-/i.test(String(s.name || ''))).map(s => s.name)));
    const r = await rpc('terminal.create', { name });
    if (r.target) await terminalOpenTarget(r.target);
    await terminalRefreshSessions({ keepCurrent: true });
  }

  async function terminalCloseTarget(target) {
    if (!target) return;
    const closingActive = terminalTargetsEqual(target, state.terminal.target);
    if (state.terminal.ptyId && closingActive) {
      await rpc('terminal.ptyClose', { id: state.terminal.ptyId }).catch(() => {});
      state.terminal.ptyId = null;
      state.terminal.term?.reset?.();
    }
    if (/^aura-term-/i.test(String(target.session || ''))) {
      await rpc('terminal.kill', { target, scope: 'session' }).catch(terminalShowError);
    }
    if (closingActive) {
      state.terminal.target = null;
      state.terminal.displayTarget = null;
    }
    await terminalRefreshSessions();
  }

  function terminalWcwidth(codepoint) {
    if (!Number.isFinite(codepoint)) return 1;
    if (codepoint === 0) return 0;
    if (codepoint < 32 || (codepoint >= 0x7f && codepoint < 0xa0)) return 0;
    // Combining marks: Vietnamese and other accented text must not advance the
    // terminal cell, otherwise xterm's canvas cursor/scroll math drifts.
    if ((codepoint >= 0x0300 && codepoint <= 0x036f) ||
        (codepoint >= 0x1ab0 && codepoint <= 0x1aff) ||
        (codepoint >= 0x1dc0 && codepoint <= 0x1dff) ||
        (codepoint >= 0x20d0 && codepoint <= 0x20ff) ||
        (codepoint >= 0xfe20 && codepoint <= 0xfe2f)) return 0;
    if ((codepoint >= 0x1100 && codepoint <= 0x115f) ||
        codepoint === 0x2329 || codepoint === 0x232a ||
        (codepoint >= 0x2e80 && codepoint <= 0xa4cf && codepoint !== 0x303f) ||
        (codepoint >= 0xac00 && codepoint <= 0xd7a3) ||
        (codepoint >= 0xf900 && codepoint <= 0xfaff) ||
        (codepoint >= 0xfe10 && codepoint <= 0xfe19) ||
        (codepoint >= 0xfe30 && codepoint <= 0xfe6f) ||
        (codepoint >= 0xff00 && codepoint <= 0xff60) ||
        (codepoint >= 0xffe0 && codepoint <= 0xffe6) ||
        (codepoint >= 0x1f300 && codepoint <= 0x1f64f) ||
        (codepoint >= 0x1f900 && codepoint <= 0x1f9ff)) return 2;
    return 1;
  }

  async function ensureXterm() {
    if (state.terminal.term) return state.terminal.term;
    await loadVendorScript('xterm/xterm.js');
    await loadVendorScript('xterm/addon-fit.js').catch(() => {});
    const Terminal = window.Terminal;
    if (!Terminal) throw new Error('xterm.js failed to load');
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      smoothScrollDuration: 0,
      fastScrollSensitivity: 3,
      scrollOnUserInput: false,
      macOptionIsMeta: true,
      overviewRulerWidth: 0,
      allowTransparency: false,
      theme: {
        background: '#2d2d2d',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        selectionBackground: '#4d4d4d',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
      },
      scrollback: 5000,
    });
    term.onResize(({ cols, rows }) => {
      if (state.terminal.ptyId) rpc('terminal.ptyResize', { id: state.terminal.ptyId, cols, rows }).catch(() => {});
    });
    try {
      term.unicode?.register?.({ version: 'aura', wcwidth: terminalWcwidth });
      if (term.unicode) term.unicode.activeVersion = 'aura';
    } catch {}
    state.terminal.term = term;
    if (window.FitAddon?.FitAddon) {
      state.terminal.fit = new window.FitAddon.FitAddon();
      term.loadAddon(state.terminal.fit);
    }
    term.open(els.terminalViewport);
    // DOM renderer only. The canvas renderer blit-copies rows on scroll and
    // leaves stale glyphs near the left edge (ghosting); a full resize repaints
    // cleanly, which is why dragging the splitter briefly "fixed" it. The DOM
    // renderer repositions real rows on scroll and cannot ghost.
    state.terminal.fit?.fit?.();
    if (window.ResizeObserver && els.codingPanel) {
      state.terminal.resizeObserver = new ResizeObserver(() => terminalFit());
      state.terminal.resizeObserver.observe(els.codingPanel);
      if (els.terminalViewport) state.terminal.resizeObserver.observe(els.terminalViewport);
    }
    term.onData(data => {
      if (!state.terminal.ptyId) return;
      const selected = state.terminal.term?.hasSelection?.() || false;
      if (selected && data === '\x03') return;
      rpc('terminal.ptyInput', { id: state.terminal.ptyId, data }).catch(terminalShowError);
    });
    els.terminalViewport?.addEventListener('paste', async (e) => {
      if (!state.terminal.ptyId) return;
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text) rpc('terminal.ptyInput', { id: state.terminal.ptyId, data: text }).catch(terminalShowError);
    });

    els.terminalViewport?.addEventListener('keydown', (e) => {
      const key = String(e.key || '').toLowerCase();
      const shortcut = e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey) && (key === 'c' || key === 'v');
      if (!shortcut) return;
      if (key === 'c') {
        const text = state.terminal.term?.getSelection?.() || '';
        if (text) navigator.clipboard.writeText(text).catch(() => {});
      } else if (key === 'v' && state.terminal.ptyId) {
        navigator.clipboard.readText()
          .then(text => { if (text) return rpc('terminal.ptyInput', { id: state.terminal.ptyId, data: text }); })
          .catch(() => {});
      }
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
    }, true);
    term.attachCustomKeyEventHandler((e) => {
      const key = String(e.key || '').toLowerCase();
      const pasteCombo = e.shiftKey && key === 'v' && (e.ctrlKey || e.metaKey) && !e.altKey;
      const copyCombo = e.shiftKey && key === 'c' && (e.ctrlKey || e.metaKey) && !e.altKey;
      if (copyCombo) {
        if (e.type === 'keydown') {
          const text = term.getSelection?.() || '';
          if (text) navigator.clipboard.writeText(text).catch(() => {});
        }
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
        return false;
      }
      if (pasteCombo) {
        if (e.type === 'keydown' && state.terminal.ptyId) {
          navigator.clipboard.readText()
            .then(text => { if (text) return rpc('terminal.ptyInput', { id: state.terminal.ptyId, data: text }); })
            .catch(() => {});
        }
        e.preventDefault?.();
        e.stopPropagation?.();
        e.stopImmediatePropagation?.();
        return false;
      }
      return true;
    });
    return term;
  }

  function terminalFit() {
    if (!codingPaneVisible() || !state.terminal.term) return;
    if (state.terminal.fitRaf) return;
    state.terminal.fitRaf = requestAnimationFrame(() => {
      state.terminal.fitRaf = 0;
      try {
        const beforeCols = state.terminal.term.cols || 0;
        const beforeRows = state.terminal.term.rows || 0;
        state.terminal.fit?.fit?.();
        const cols = state.terminal.term.cols || 120;
        const rows = state.terminal.term.rows || 34;
        if (state.terminal.ptyId && (cols !== beforeCols || rows !== beforeRows)) {
          rpc('terminal.ptyResize', { id: state.terminal.ptyId, cols, rows }).catch(() => {});
        }
      } catch {}
    });
  }

  async function terminalOpenTarget(target) {
    const prevTarget = state.terminal.target;
    const sameTarget = terminalTargetsEqual(prevTarget, target);
    state.terminal.target = target;
    state.terminal.displayTarget = null;
    state.terminal.lastData = '';
    if (els.terminalTargetLabel) els.terminalTargetLabel.textContent = terminalTargetText(target);
    const term = await ensureXterm();
    if (state.terminal.ptyId) await rpc('terminal.ptyClose', { id: state.terminal.ptyId }).catch(() => {});
    state.terminal.ptyId = `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    // External tmux sessions should scroll/redraw via tmux itself, not xterm's
    // local scrollback. Keeping xterm scrollback for attached tmux panes leaves
    // stale DOM rows visible when wheel-scrolling through previous output.
    term.options.scrollback = /^aura-term-/i.test(String(target.session || '')) ? 5000 : 0;
    if (!sameTarget) term.reset();
    terminalFit();
    await new Promise(resolve => requestAnimationFrame(resolve));
    await rpc('terminal.ptyOpen', { id: state.terminal.ptyId, target, cols: term.cols || 120, rows: term.rows || 34 });
    renderTerminalSessions();
    term.focus();
  }

  function flushTerminalWrite() {
    state.terminal.writeRaf = 0;
    if (!state.terminal.term || !state.terminal.writeBuf) return;
    const data = state.terminal.writeBuf;
    state.terminal.writeBuf = '';
    state.terminal.term.write(data);
  }

  function queueTerminalWrite(data) {
    if (!data) return;
    state.terminal.writeBuf += String(data);
    if (state.terminal.writeRaf) return;
    state.terminal.writeRaf = requestAnimationFrame(flushTerminalWrite);
  }

  function clearTerminalWriteBuffer() {
    if (state.terminal.writeRaf) cancelAnimationFrame(state.terminal.writeRaf);
    state.terminal.writeRaf = 0;
    state.terminal.writeBuf = '';
  }

  function onTerminalData(payload) {
    if (!payload || payload.id !== state.terminal.ptyId || !state.terminal.term) return;
    queueTerminalWrite(payload.data || '');
  }
  function onTerminalExit(payload) {
    if (!payload || payload.id !== state.terminal.ptyId) return;
    clearTerminalWriteBuffer();
    state.terminal.term?.writeln(`\r\n[tmux detached: ${payload.code ?? ''}]`);
    state.terminal.ptyId = null;
  }

  function renderAnsi(text) {
    const esc = escapeHtml(String(text || ''));
    const colors = {
      30: 'term-fg-black', 31: 'term-fg-red', 32: 'term-fg-green', 33: 'term-fg-yellow',
      34: 'term-fg-blue', 35: 'term-fg-magenta', 36: 'term-fg-cyan', 37: 'term-fg-white',
      90: 'term-fg-bright-black', 91: 'term-fg-red', 92: 'term-fg-green', 93: 'term-fg-yellow',
      94: 'term-fg-blue', 95: 'term-fg-magenta', 96: 'term-fg-cyan', 97: 'term-fg-white',
    };
    let open = '';
    return esc.replace(/\x1b\[([0-9;]*)m/g, (_, seq) => {
      const codes = String(seq || '0').split(';').map(n => Number(n || 0));
      if (codes.includes(0)) { const close = open ? '</span>' : ''; open = ''; return close; }
      const cls = codes.map(c => colors[c]).filter(Boolean).join(' ');
      if (!cls) return '';
      const close = open ? '</span>' : '';
      open = cls;
      return `${close}<span class="${cls}">`;
    }) + (open ? '</span>' : '');
  }

  async function terminalCapture(lines = 2000) {
    if (!state.terminal.target || !els.terminalViewport) return;
    const r = await rpc('terminal.capture', { target: state.terminal.target, lines });
    const data = r.data || '';
    state.terminal.pollErrors = 0;
    if (data !== state.terminal.lastData) {
      state.terminal.lastData = data;
      els.terminalViewport.innerHTML = renderAnsi(data);
      els.terminalViewport.scrollTop = els.terminalViewport.scrollHeight;
    }
  }

  function terminalStartPoll() {
    terminalStopPoll();
    state.terminal.pollTimer = setInterval(() => terminalCapture(4000).catch(e => {
      state.terminal.pollErrors = (state.terminal.pollErrors || 0) + 1;
      if (state.terminal.pollErrors >= 3) terminalShowError(e);
    }), 900);
  }
  function terminalStopPoll() {
    if (state.terminal.pollTimer) clearInterval(state.terminal.pollTimer);
    state.terminal.pollTimer = null;
  }
  function terminalStartRefresh() {
    terminalStopRefresh();
    state.terminal.refreshTimer = setInterval(() => {
      if (!codingPaneVisible()) return;
      terminalRefreshSessions({ noAutoOpen: true }).catch(() => {});
    }, 1800);
  }
  function terminalStopRefresh() {
    if (state.terminal.refreshTimer) clearInterval(state.terminal.refreshTimer);
    state.terminal.refreshTimer = null;
  }

  function bindTerminalSplitter() {
    if (!els.terminalSplitter || !els.codingPanel) return;
    let dragging = false;
    let pointerId = null;
    let lastX = 0;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (!dragging) return;
      const rect = els.codingPanel.getBoundingClientRect();
      const w = Math.max(160, Math.min(420, rect.right - lastX));
      els.codingPanel.style.setProperty('--terminal-sidebar-w', `${w}px`);
      terminalFit();
    };
    const move = (e) => {
      if (!dragging) return;
      if (e.buttons === 0) { up(e); return; }
      lastX = e.clientX;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      document.body.classList.remove('terminal-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      try { els.terminalSplitter.releasePointerCapture?.(e?.pointerId ?? pointerId); } catch {}
      pointerId = null;
    };
    els.terminalSplitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      pointerId = e.pointerId;
      lastX = e.clientX;
      document.body.classList.add('terminal-resizing');
      els.terminalSplitter.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    els.terminalSplitter.addEventListener('lostpointercapture', up);
  }
  function bindWorkspaceSplitter() {
    if (!els.workspaceSplitter || !els.workspaceShell) return;
    let dragging = false;
    let pointerId = null;
    let lastEvent = null;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (!dragging || !lastEvent) return;
      const e = lastEvent;
      const rect = els.workspaceShell.getBoundingClientRect();
      let pct;
      if (isVerticalWorkspaceLayout()) {
        pct = ((e.clientY - rect.top) / Math.max(1, rect.height)) * 100;
      } else {
        pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
      }
      state.workspaceSplitPct = Math.max(25, Math.min(75, pct));
      if (els.workspaceShell) els.workspaceShell.style.setProperty('--workspace-split-pct', `${state.workspaceSplitPct}%`);
      terminalFit();
    };
    const move = (e) => {
      if (!dragging) return;
      if (e.buttons === 0) { up(e); return; }
      lastEvent = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      localStorage.setItem('auraStudio.workspaceSplitPct', String(Math.round(state.workspaceSplitPct)));
      document.body.classList.remove('workspace-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      try { els.workspaceSplitter.releasePointerCapture?.(e?.pointerId ?? pointerId); } catch {}
      pointerId = null;
      lastEvent = null;
    };
    els.workspaceSplitter.addEventListener('pointerdown', (e) => {
      if (!state.workspaceSplit) return;
      dragging = true;
      pointerId = e.pointerId;
      lastEvent = e;
      document.body.classList.add('workspace-resizing');
      els.workspaceSplitter.setPointerCapture?.(e.pointerId);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      e.preventDefault();
    });
    els.workspaceSplitter.addEventListener('lostpointercapture', up);
  }


  async function updateProxyPill(proxy) {
    if (!els.proxyPill) return;
    const ready = !!proxy?.ready;
    const port = proxy?.port;
    const name = proxy?.containerName || '';
    const base = proxy?.baseUrl || (port ? `http://127.0.0.1:${port}` : 'active proxy');
    const label = ready ? (port ? `:${port}` : 'ready') : 'down';
    els.proxyPill.textContent = `proxy ${label}`;
    els.proxyPill.title = ready
      ? `${name ? name + ' · ' : ''}Chat sends via ${base}`
      : 'No Aether proxy connected';
    els.proxyPill.classList.toggle('ready', ready);
    els.proxyPill.classList.toggle('down', !ready);
  }

  function isEditableTarget(target = document.activeElement) {
    const el = target?.closest ? target : target?.parentElement;
    return !!el?.closest?.('textarea,input,select,[contenteditable=""],[contenteditable="true"]');
  }

  function showFatalBanner(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    const body = document.createElement('div');
    body.className = 'msg-body';
    const err = document.createElement('div');
    err.className = 'msg-error';
    err.innerHTML = `<b>Aether cannot start</b><br><br>${escapeHtml(msg)}<br><br>` +
      `<span class="muted small">Open VS Code → Output → Aether for the full error. ` +
      `If it mentions "NODE_MODULE_VERSION", the bundled SQLite binary was built for the wrong Node ABI — reinstall the latest VSIX.</span>`;
    body.appendChild(err);
    wrap.appendChild(body);
    els.threadInner.innerHTML = '';
    els.threadInner.appendChild(wrap);
  }

  boot().catch(err => {
    console.error('[studio] boot failed', err);
    showFatalBanner(`Boot crashed: ${err.message}`);
  });

  /* ── Message listener (replies + broadcasts) ─────────────────────── */
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) return;
    // Mermaid iframe size auto-fit: each ```mermaid block posts back its
    // rendered scrollHeight so we can shrink the iframe to fit.
    if (msg.type === 'mermaidSize' && msg.id) {
      const f = document.querySelector(`iframe[data-mer-id="${msg.id}"]`);
      if (f) f.style.height = Math.max(80, Math.min(800, msg.h + 16)) + 'px';
      return;
    }
    // 0.4.267 — visualise artifacts (art-html-frame) post
    // {type:'aura.visualise.resize',h}. Match the source frame by the name
    // baked into the resize script (vf-<id>), then fall back to the sole
    // frame when name/source can't identify it (null-origin sandbox).
    if (msg.type === 'aura.artifact.resize' && typeof msg.h === 'number') {
      const frames = document.querySelectorAll('iframe.artifact-frame[data-artifact-frame="1"]');
      let target = null;
      for (const fr of frames) {
        if ((msg.name && fr.name && msg.name === fr.name) || (fr.contentWindow && fr.contentWindow === e.source)) {
          target = fr;
          break;
        }
      }
      if (!target && frames.length) target = frames[frames.length - 1];
      if (target) {
        const keepTopUntil = Number(target.dataset.keepTopUntil || 0);
        if (target.dataset.noAutoResize !== '1') {
          target.style.height = Math.max(320, Math.min(12000, msg.h + 2)) + 'px';
        }
        if (Date.now() < keepTopUntil) {
          const scroller = target.closest('.artifact-body');
          if (scroller) { scroller.scrollTop = 0; scroller.scrollLeft = 0; }
        }
      }
      return;
    }
    if (msg.type === 'aura.artifact.zoom' && typeof msg.deltaY === 'number') {
      const btn = els.artifactBody?.querySelector(msg.deltaY < 0 ? '[data-zoom-act="in"]' : '[data-zoom-act="out"]');
      if (btn) btn.click();
      return;
    }
    if (msg.type === 'aura.visualise.resize' && typeof msg.h === 'number') {
      const frames = document.querySelectorAll('iframe.art-html-frame');
      let target = null;
      for (const fr of frames) {
        if ((msg.name && fr.name && msg.name === fr.name)
            || (msg.name && fr.dataset && ('vf-' + fr.dataset.visualiseId) === msg.name)
            || (fr.contentWindow && fr.contentWindow === e.source)) {
          target = fr;
          break;
        }
      }
      // Fallback: apply to the most-recently-attached frame that still sits at
      // the initial 200px placeholder. This covers null-origin sandboxed
      // srcdoc iframes where both name and contentWindow matching fail.
      if (!target && frames.length) {
        for (let i = frames.length - 1; i >= 0; i--) {
          const h = parseInt(frames[i].style.height, 10) || 0;
          if (h <= 220) { target = frames[i]; break; }
        }
        if (!target) target = frames[frames.length - 1];
      }
      if (target && target.dataset.containedViewport !== 'true') {
        target.style.height = Math.min(12000, msg.h) + 'px';
      }
      return;
    }
    // Iframe's show() detail panel injects content below fold — scroll parent
    // so the newly revealed detail panel is visible without manual scroll.
    if (msg.type === 'aura.visualise.scrollToBottom') {
      const frames = document.querySelectorAll('iframe.art-html-frame');
      let target = null;
      for (const fr of frames) {
        if ((msg.name && fr.name && msg.name === fr.name) || fr.contentWindow === e.source) {
          target = fr;
          break;
        }
      }
      if (!target && frames.length === 1) target = frames[0];
      if (target) target.scrollIntoView({behavior: 'smooth', block: 'end'});
      return;
    }
    // sendPrompt bridge: visualise iframes call sendPrompt(text) which posts
    // {type:'aura.sendPrompt', text} — we inject it into the composer and submit.
    if (msg.type === 'aura.sendPrompt' && msg.text) {
      if (els.composerInput) {
        els.composerInput.value = String(msg.text);
        els.composerInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (els.sendBtn) els.sendBtn.click();
      return;
    }
    if (msg.type === 'reply' && msg.requestId && pending.has(msg.requestId)) {
      const { resolve } = pending.get(msg.requestId);
      pending.delete(msg.requestId);
      if (msg.data && typeof msg.data === 'object' && msg.data.error) {
        console.warn('[studio] host error reply:', msg.data.error);
      }
      resolve(msg.data);
      return;
    }
    if (msg.type === 'error') {
      // Host posted this from its onDidReceiveMessage catch (unhandled throw
      // in handleMessage). Resolve the pending RPC with { error } so callers
      // can show it; otherwise they'd hang until the 120s timeout.
      const p = msg.requestId ? pending.get(msg.requestId) : undefined;
      if (p) { pending.delete(msg.requestId); p.resolve({ error: msg.error }); }
      console.warn('[studio] host dispatch error:', msg.error);
      return;
    }
    if (msg.type === 'agents.snapshot')  return onAgentsSnapshot(msg.payload);
    if (msg.type === 'agents.propagation') return onAgentPropagation(msg.payload);
    if (msg.type === 'agent.handoffUpdated') return onAgentHandoffUpdated(msg.payload);
    if (msg.type === 'agent.submitted') return; // handled by doSubmitAgent RPC reply
    if (msg.type === 'agent.created' || msg.type === 'agent.status' || msg.type === 'agent.completed' || msg.type === 'agent.released') {
      return onAgentLifecycle(msg.payload);
    }
    if (msg.type === 'agent.contextGuard') return onAgentContextGuard(msg.payload);
    if (msg.type === 'agent.artifact')  return onAgentArtifact(msg.payload);
    if (msg.type === 'agent.chunk')     return onAgentChunk(msg.payload);
    if (msg.type === 'agent.tool')      return onAgentTool(msg.payload);
    if (msg.type === 'agent.usage')     return onAgentUsage(msg.payload);
    if (msg.type === 'state.invalidate') return onInvalidate(msg.payload?.scope, msg.payload);
    if (msg.type === 'proxy.state' || msg.type === 'proxy.status') { updateProxyPill(msg.payload || {}); return; }
    if (msg.type === 'host.state') return hostRender(msg.payload);
    if (msg.type === 'memory.observation') {
      // 0.4.89 — claude-mem status is surfaced as a persistent card at
      // the end of the assistant bubble (not just a fading toast). The
      // card is expandable — click to fetch the observations the worker
      // just persisted for this turn.
      onMemoryObservation(msg.payload || {});
      return;
    }
    if (msg.type === 'mineru.pickBackend') return onMineruPickBackend(msg.payload);
    if (msg.type === 'proxy.changed')    return updateProxyPill(msg.payload?.proxy);
    if (msg.type === 'chat.userTurn')    return onUserTurnId(msg.payload);
    if (msg.type === 'chat.attachProgress') return onAttachProgress(msg.payload);
    if (msg.type === 'chat.outerCapReached') return onOuterCapReached(msg.payload);
    if (msg.type === 'chat.asstTurn')    return onAsstTurnId(msg.payload);
    if (msg.type === 'chat.asstStart')   return onAsstStart(msg.payload);
    if (msg.type === 'chat.start')       return onChatStart(msg.payload);
    if (msg.type === 'chat.chunk')       return onChatChunk(msg.payload);
    if (msg.type === 'chat.done')        return onChatDone(msg.payload);
    if (msg.type === 'chat.queued')      return onChatQueued(msg.payload);
    if (msg.type === 'chat.error')       return onChatError(msg.payload);
    if (msg.type === 'chat.devSandboxMissing') {
      // Backend rejected a send because Developer Mode is on but the
      // sandbox-dev container isn't installed. Flip the toggle off so the
      // user can resend after installing, and surface the same warning.
      state.developerMode = false;
      const banner = $('#devModeBanner'); if (banner) banner.hidden = true;
      const btn = $('#devModeBtn');
      if (btn) {
        btn.classList.remove('on');
        btn.setAttribute('aria-pressed', 'false');
      }
      showDevSandboxMissingToast();
      return;
    }
    if (msg.type === 'chat.streaming')   return onChatStreaming(msg.payload);
    if (msg.type === 'chat.usage')       return onChatUsage(msg.payload);
    if (msg.type === 'chat.compact.start')    return onCompactStart(msg.payload);
    if (msg.type === 'chat.compact.progress') return onCompactProgress(msg.payload);
    if (msg.type === 'chat.compact.done')     return onCompactDone(msg.payload);
    if (msg.type === 'chat.thinkingRecurse.start') return onRecurseStart(msg.payload);
    if (msg.type === 'chat.thinkingRecurse.step')  return onRecurseStep(msg.payload);
    if (msg.type === 'chat.thinkingRecurse.done')  return onRecurseDone(msg.payload);
    if (msg.type === 'chat.continuation.start')    return onContinuationStart(msg.payload);
    if (msg.type === 'chat.continuation.step')     return onContinuationStep(msg.payload);
    if (msg.type === 'chat.continuation.done')     return onContinuationDone(msg.payload);
    if (msg.type === 'chat.continuation.hint')     return onContinuationHint(msg.payload);
    if (msg.type === 'chat.clarifyAsk')            return onClarifyAsk(msg.payload);
    if (msg.type === 'terminal.data')              return onTerminalData(msg.payload);
    if (msg.type === 'terminal.exit')              return onTerminalExit(msg.payload);
    if (msg.type === 'tool.start')       return onToolStart(msg.payload);
    if (msg.type === 'tool.done')        return onToolDone(msg.payload);
    if (msg.type === 'pyodide.run')      return onPyodideRun(msg.payload);
    if (msg.type === 'image.attach')     return onImageAttach(msg.payload);
    if (msg.type === 'file.attach')      return onFileAttach(msg.payload);
    if (msg.type === 'artifact.attach')  { rememberArtifact(msg.payload); return onArtifactAttach(msg.payload); }
    if (msg.type === 'artifact.updated') { return onArtifactUpdated(msg.payload); }
  });

  /** Host broadcast — the assistant or one of its tools produced an image.
   *  Append a card to the active chat's last assistant bubble. The card
   *  loads the bytes off the `webviewUri` the host already escaped, so we
   *  don't have to round-trip through file.readAsDataUri. */
  function onImageAttach(payload, _retry = 0) {
    const { chatId, webviewUri, filename, mediaType, source, toolUseId } = payload || {};
    if (!chatId || chatId !== state.activeChatId) return;
    if (payload?.artifactId || payload?.id || payload?.pinned || payload?.isAuraArtifact) return;
    if (!webviewUri) return;
    // 0.4.106 — trace image landing: without a toolUseId we fall back to
    // the bubble's artifact-strip (bottom of bubble, AFTER any assistant
    // caption text). User reported the caption "Đây là ảnh…" appearing
    // above the cat image, which is exactly that fallback.
    if (_retry === 0) {
      try { console.log('[studio] onImageAttach', {filename, mediaType, tid: toolUseId, chat: chatId}); } catch {}
    }
    // 0.4.49 — strict anchoring. The image must end up next to the tool
    // call that produced it. If we have a toolUseId, keep retrying for
    // up to ~1 second waiting for DOM to render; if that tool block
    // still doesn't exist, the image belongs to a turn that's no
    // longer in this chat → DROP it instead of dumping at the bottom.
    // Without this every reload re-surfaces old python images below
    // the last assistant bubble (user-visible regression on reload).
    if (toolUseId) {
      const found = els.threadInner.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
      );
      const foundResult = els.threadInner.querySelector(
        `.blk-tool-result[data-tool-use-id="${cssEscape(String(toolUseId))}"]`
      );
      // v0.4.264 — also require .blk-tool-result before rendering so the
      // image lands AFTER it (instead of between tool_use and tool_result
      // when tool_result renders a beat after tool-done).
      if (!found || !foundResult) {
        if (_retry < 60) {     // ~60 frames ≈ 1s — DOM render budget
          requestAnimationFrame(() => onImageAttach(payload, _retry + 1));
          return;
        }
        // Artifact-backed image tools already render through artifact.attach.
        // If the matching tool DOM never appears, this is a stale legacy
        // image.attach from an older/other turn; dropping is safer than
        // appending it at the tail of the current answer.
        return;
      }
    }
    // Sandbox-produced files/images should not render inline by themselves.
    // Pinned outputs render through artifact.attach/aura_artifact_pin so the
    // user sees the artifact after the pin tool result, not after sandbox output.
    return;
    if (toolUseId && els.threadInner.querySelector(`.art-image[data-tool-use-id="${cssEscape(String(toolUseId))}"], .art-svg[data-tool-use-id="${cssEscape(String(toolUseId))}"], .art-html-card[data-tool-use-id="${cssEscape(String(toolUseId))}"]`)) return;
    if (/\/chat-images\//.test(String(payload.localPath || '')) && els.threadInner.querySelector('.art-image, .blk-image-card, .msg-image-wrap')) return;
    if (!rememberImageAttach(payload)) return;
    let anchorTool = null;
    if (toolUseId) {
      anchorTool = els.threadInner.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
      );
    }
    // Prefer the in-flight pending bubble (still has its detached body
    // when the user switched chats mid-stream); fall back to the LAST
    // visible .msg-assistant for THIS chat. Either way we tag with
    // data-chat-id so cross-chat image events don't leak.
    const a = state.pendingAsstByChat?.get?.(chatId);
    let insertAfter = null;
    let body = null;
    if (anchorTool) {
      body = anchorTool.closest('.msg-body');
    }
    if (!body && a && a.body) body = a.body;
    if (body) {
      const escaped = escapeToolContainer(insertAfter, body);
      insertAfter = escaped.insertAfter;
      body = escaped.body;
    }
    if (!body) {
      const sel = state.activeAgentId
        ? `.msg-assistant[data-agent-id="${cssEscape(state.activeAgentId)}"]`
        : `.msg-assistant[data-chat-id="${cssEscape(chatId)}"]`;
      const bubbles = els.threadInner.querySelectorAll(sel);
      const target = bubbles[bubbles.length - 1]
                  || els.threadInner.querySelectorAll('.msg-assistant')[
                       els.threadInner.querySelectorAll('.msg-assistant').length - 1
                     ];
      if (!target) return;
      body = target.querySelector('.msg-body') || target;
    }
    // Wrap in a positioned div so the download chip can overlay the corner
    // — issue #2 in 0.2.18 (MCP-generated images had no save action).
    const wrap = document.createElement('div');
    wrap.className = 'msg-image-wrap';
    wrap.title = source || filename || '';
    stampImageAttachKeys(wrap, payload);

    // 0.4.29 — clicking the image now opens a lightbox overlay (Esc /
    // click-outside to close). Plain <a target="_blank"> doesn't work in
    // VS Code webviews (navigation is blocked by the panel sandbox), and
    // having no click action at all reads as broken.
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'msg-image-card';
    card.title = 'Click to enlarge';
    const img = document.createElement('img');
    img.src = webviewUri;
    img.alt = filename || 'image';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    card.appendChild(img);
    card.addEventListener('click', (e) => {
      // Ignore clicks that bubbled from a download button overlay.
      if (e.target.closest('.msg-image-dl')) return;
      e.preventDefault();
      e.stopPropagation();
      openImageLightbox(webviewUri, filename);
    });
    wrap.appendChild(card);

    // Two download buttons (parity with branch aura_v1_pre_studio_port):
    //   ↓💻 = save to your VS Code client machine (browser download)
    //   ↓🐧 = save to the Linux host machine (showSaveDialog → fs.copy)
    //
    // CRITICAL (#F9 in 0.4.2): a plain <a download href="vscode-webview://...">
    // navigates the WEBVIEW frame on click — VS Code interprets this as
    // "panel wants to leave its origin" and tears down the panel. We had
    // a "click → extension crash + state lost" bug because of this. The
    // safe pattern is to fetch the bytes via the same webview URI, wrap
    // in a Blob URL, then trigger a programmatic download (which the
    // webview handles as a *download*, not a navigation).
    const dlClient = document.createElement('button');
    dlClient.type = 'button';
    dlClient.className = 'msg-image-dl';
    dlClient.title = 'Save to your VS Code machine (client)';
    dlClient.setAttribute('aria-label', 'Save to client');
    dlClient.style.right = '52px';
    dlClient.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
    dlClient.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 0.4.31 — VS Code webview blocks showSaveFilePicker (Permissions-
      // Policy denies it inside the panel iframe). The closest thing to a
      // real "Save As" we can offer client-side is an input prompt for
      // the filename; the bytes still land in the user's Downloads
      // folder because that's the only place <a download> can target.
      const defaultName = filename || ('image-' + Date.now() + '.png');
      let chosen;
      try {
        chosen = await showInputModal('Save as (file will go to your Downloads folder):', defaultName);
      } catch { chosen = defaultName; }
      if (!chosen) return;
      // Defensive: keep the original extension if the user wiped it.
      const origExt = (defaultName.split('.').pop() || '').toLowerCase();
      if (origExt && !chosen.toLowerCase().endsWith('.' + origExt)) {
        chosen = chosen + '.' + origExt;
      }
      try {
        const resp = await fetch(webviewUri);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        const tmp  = document.createElement('a');
        tmp.href = url;
        tmp.download = chosen;
        document.body.appendChild(tmp);
        tmp.click();
        tmp.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showToast(`Saved ${chosen} to your Downloads`);
      } catch (err) {
        console.warn('[studio] client download failed:', err);
        showToast(`Save failed: ${err.message || err}`, 'error', 5000);
      }
    });
    wrap.appendChild(dlClient);

    const dlHost = document.createElement('button');
    dlHost.type = 'button';
    dlHost.className = 'msg-image-dl';
    dlHost.title = 'Save to the Linux host (where the extension runs)';
    dlHost.setAttribute('aria-label', 'Save to Linux host');
    dlHost.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    dlHost.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await saveAsDownload({ path: payload.localPath });
    });
    wrap.appendChild(dlHost);

    // v0.4.264 — show host storage path under the image (like file cards do).
    if (payload.localPath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'msg-image-path';
      pathEl.textContent = payload.localPath;
      pathEl.title = payload.localPath;
      wrap.appendChild(pathEl);
    }

    if (anchorTool) {
      // Anchor mode: drop the card immediately after the tool group that
      // emitted it (or the tool_use itself if the group isn't there). The
      // tool block sits inside a .tool-card / <details> wrapper most of the
      // time — walk up to the OUTERMOST sibling of body so we don't end up
      // nested inside the tool_use details element.
      let after = anchorTool;
      while (after.parentElement && after.parentElement !== body) after = after.parentElement;
      // 0.4.108 — skip forward past any tool_result sibling that belongs
      // to the SAME tool call. Without this the image lands between the
      // tool_use header and its matching tool_result block. Both live
      // stream and reload rebuild the DOM as separate top-level children,
      // so we scan forward as long as the next sibling still carries the
      // same tool_use_id (either directly, or wrapped in a data-blk-idx
      // slot / .tool-card container).
      const matchesResult = (el) => {
        if (!el || !el.querySelector) return false;
        const sel = `.blk-tool-result[data-tool-use-id="${cssEscape(String(toolUseId))}"]`;
        return el.matches?.(sel) || !!el.querySelector(sel);
      };
      const isEmptyStrip = (el) => el && el.classList && el.classList.contains('msg-artifact-strip') && !el.firstChild;
      while (after.nextSibling && (matchesResult(after.nextSibling) || isEmptyStrip(after.nextSibling))) {
        after = after.nextSibling;
      }
      after.parentNode.insertBefore(wrap, after.nextSibling);
    } else {
      // 0.4.131 — no anchor: append directly to body. Previously routed to
      // .msg-artifact-strip at bubble bottom, which pushed file cards far
      // from the assistant text that referenced them.
      body.appendChild(wrap);
    }
    if (chatId === state.activeChatId && typeof scrollThreadToEnd === 'function') {
      scrollThreadToEnd();
    }
  }

  /** CSS.escape polyfill — older webview engines don't have it. */
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  }

  /** 0.4.29/0.4.33 — full-viewport image preview with zoom + pan.
   *  Controls:
   *    • mouse wheel  → zoom toward cursor
   *    • drag         → pan (when zoomed in)
   *    • +/- buttons  → zoom step
   *    • ⤢ button     → reset to fit
   *    • Esc / click outside / ✕ → close
   *    • double-click image → toggle 100% ↔ fit
   */
  /** 0.4.59 — shared lightbox shell. Hands you back the transform target.
   *  Renderer fns (raster img / inline SVG) populate `stage` themselves. */
  function _mountLightbox(filename, renderInto) {
    const old = document.getElementById('imageLightbox');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'imageLightbox';
    overlay.className = 'image-lightbox';
    overlay.innerHTML = `
      <div class="image-lightbox-toolbar">
        <button class="image-lightbox-btn" data-act="zoom-out" title="Zoom out (−)">−</button>
        <span class="image-lightbox-pct">100%</span>
        <button class="image-lightbox-btn" data-act="zoom-in"  title="Zoom in (+)">+</button>
        <button class="image-lightbox-btn" data-act="fit"      title="Fit to screen">⤢</button>
        <button class="image-lightbox-btn" data-act="close"    title="Close (Esc)">✕</button>
      </div>
      <div class="image-lightbox-stage"></div>
    `;
    const stage = overlay.querySelector('.image-lightbox-stage');
    const pct   = overlay.querySelector('.image-lightbox-pct');
    const target = renderInto(stage, filename);
    return { overlay, stage, target, pct };
  }

  /** 0.4.59 — wire zoom/pan/keyboard events to a target element inside the
   *  lightbox shell. Called by both raster and SVG renderers. */
  function _bindLightbox(overlay, target, pct) {
    let scale = 1, tx = 0, ty = 0;
    let isPanning = false;
    let lastX = 0, lastY = 0;

    const applyTransform = () => {
      target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      pct.textContent = Math.round(scale * 100) + '%';
      target.style.cursor = scale > 1.01 ? (isPanning ? 'grabbing' : 'grab') : 'zoom-in';
    };
    const fit = () => { scale = 1; tx = 0; ty = 0; applyTransform(); };
    const zoomAt = (factor, cx, cy) => {
      const rect = target.getBoundingClientRect();
      const ox = cx - (rect.left + rect.width  / 2);
      const oy = cy - (rect.top  + rect.height / 2);
      const newScale = Math.max(0.1, Math.min(8, scale * factor));
      const k = newScale / scale;
      tx = tx * k + ox * (1 - k);
      ty = ty * k + oy * (1 - k);
      scale = newScale;
      applyTransform();
    };

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') return close();
      if (e.key === '+' || e.key === '=') zoomAt(1.2, innerWidth/2, innerHeight/2);
      if (e.key === '-' || e.key === '_') zoomAt(1/1.2, innerWidth/2, innerHeight/2);
      if (e.key === '0') fit();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target.closest('.image-lightbox-toolbar')) return;
      if (target.contains(e.target) || e.target === target) return;
      close();
    });
    overlay.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.15 : 1/1.15, e.clientX, e.clientY);
    }, { passive: false });
    target.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (scale > 1.01) fit();
      else zoomAt(2, e.clientX, e.clientY);
    });
    target.addEventListener('mousedown', (e) => {
      if (scale <= 1.01) return;
      isPanning = true; lastX = e.clientX; lastY = e.clientY;
      applyTransform();
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      tx += e.clientX - lastX;
      ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      applyTransform();
    });
    document.addEventListener('mouseup', () => { isPanning = false; applyTransform(); });

    overlay.querySelectorAll('button[data-act]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'close')    close();
        if (act === 'fit')      fit();
        if (act === 'zoom-in')  zoomAt(1.25, innerWidth/2, innerHeight/2);
        if (act === 'zoom-out') zoomAt(1/1.25, innerWidth/2, innerHeight/2);
      });
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    applyTransform();
  }

  function openImageLightbox(src, filename) {
    const { overlay, target, pct } = _mountLightbox(filename, (stageEl) => {
      const el = document.createElement('img');
      el.className = 'image-lightbox-img';
      el.alt = filename || '';
      el.src = src;
      stageEl.appendChild(el);
      return el;
    });
    _bindLightbox(overlay, target, pct);
  }

  /** 0.4.59 — open the lightbox with an INLINE SVG clone. Avoids the
   *  data-URL `<img>` failure mode (broken-image icon on the dark overlay
   *  in 0.4.58) — Chrome occasionally rejects oversized / specially-encoded
   *  data:image/svg+xml URLs. The clone keeps text selectable and inherits
   *  zero CSS from the chat card, so we wrap it in a dark surface. */
  function openSvgLightbox(svgEl, filename) {
    const { overlay, target, pct } = _mountLightbox(filename, (stageEl) => {
      const wrap = document.createElement('div');
      // 0.4.61 — also tag with `blk-svg-stage` so the entire palette/contrast
      // ruleset (text → svg-ink, white rects → transparent, pastel → saturated,
      // c-* groups → palette colours) cascades onto the cloned SVG. Without it
      // the lightbox renders default-black text on the dark backdrop ("đen thui").
      wrap.className = 'image-lightbox-svg blk-svg-stage';
      const clone = svgEl.cloneNode(true);
      // Strip any width/height the model baked into <svg>, and any inline
      // styles the chat-card path set. Sizing is fully owned by CSS
      // (`.image-lightbox-svg svg`), so the SVG fills the 95vw × 95vh wrap
      // and `preserveAspectRatio` handles the fit.
      clone.removeAttribute('width');
      clone.removeAttribute('height');
      clone.style.cssText = '';
      wrap.appendChild(clone);
      stageEl.appendChild(wrap);
      return wrap;
    });
    _bindLightbox(overlay, target, pct);
  }

  /** 0.4.89 — render an inline "Memory" card at the end of the current
   *  assistant bubble. Shows the claude-mem status explicitly (green if
   *  the worker accepted the transcript, red on failure). Clicking the
   *  card runs a search against the same namespace and expands a preview
   *  of the observations the worker just wrote. */
  function onMemoryObservation(payload) {
    // Child threads are transient worker contexts. Memory/compact cards belong
    // only to the root conversation that owns the final synthesis.
    if (state.activeAgentId) return;
    const { chatId, ok, namespace, error, stopReason, turnId, targetBubble } = payload || {};
    // 0.4.143 — when a reload-path call passes an explicit targetBubble,
    // trust the caller: bubble is DOM-anchored to a specific asst turn
    // inside els.threadInner. The activeChatId gate was silently
    // dropping hydration whenever the state hadn't caught up to the
    // just-rendered chat (boot loadChat race). Live-stream path (no
    // targetBubble) still guards on activeChatId because it targets the
    // "last bubble" via querySelector.
    if (!targetBubble && (!chatId || chatId !== state.activeChatId)) return;
    // While this chat is actively streaming, do not surface late observations
    // from an older turn. The current turn's observation is emitted after
    // chat.done, when streamingChats has already been cleared.
    if (!targetBubble && chatId && state.streamingChats.has(chatId)) return;

    // 0.4.115 — reload path passes targetBubble to attach a card to a
    // specific historical asst bubble. Live-stream path leaves it null
    // and the card lands on the most-recent bubble (live/pending).
    let body = null;
    if (targetBubble) {
      body = targetBubble.querySelector('.msg-body') || targetBubble;
    } else {
      // 0.4.190 — prefer the bubble whose data-turn-id matches the
      // turnId reported by the plugin. Previously we always picked "the
      // last asst bubble", which dumps the card onto the wrong turn
      // whenever a send produced multiple asst iters (or when the next
      // turn's bubble was already appended before this fire-and-forget
      // callback ran). The backend now resolves turnId in
      // firePluginAfterAssistantTurn so the card lands on the exact
      // bubble that produced the summary.
      let anchored = null;
      if (typeof turnId === 'number' && turnId >= 0) {
        anchored = els.threadInner.querySelector(
          `.msg-assistant[data-chat-id="${cssEscape(chatId)}"][data-turn-id="${turnId}"]`
        );
      }
      if (!anchored) {
        const sel = `.msg-assistant[data-chat-id="${cssEscape(chatId)}"]`;
        const bubbles = els.threadInner.querySelectorAll(sel);
        anchored = bubbles[bubbles.length - 1] || null;
      }
      if (!anchored) return;
      body = anchored.querySelector('.msg-body') || anchored;
    }
    // 0.4.184 — dedup per-bubble only. Previously the live-stream path
    // wiped every `.msg-memory-card` across the thread so the fresh card
    // lived alone on the tail bubble; this erased the still-generating
    // card on the FIRST turn as soon as turn 2's card started spinning,
    // and — when worker was slow — moved turn 1's observation into turn
    // 2's window. Now: only remove a card that's already on THIS bubble
    // (idempotent re-attach on the same turn), never sibling bubbles'.
    if (body.querySelector(':scope > .msg-memory-card, :scope > .msg-artifact-strip > .msg-memory-card')) {
      return;
    }

    const card = document.createElement('details');
    card.className = 'msg-memory-card' + (ok ? ' ok' : ' warn');

    const summary = document.createElement('summary');
    summary.className = 'mmc-summary';
    // 0.4.129 — dropped 🧠 / ⚠️ icon for a cleaner, Claude-native look;
    // status is conveyed by border colour + label wording only.
    const label = document.createElement('span'); label.className = 'mmc-label';
    label.textContent = ok
      ? `Memory saved to claude-mem${namespace ? ` (project=${namespace})` : ''}`
      : `Memory skipped: ${error || 'unknown'}`;
    const chev = document.createElement('span'); chev.className = 'mmc-chev muted small'; chev.textContent = '▾';
    summary.appendChild(label); summary.appendChild(chev);
    card.appendChild(summary);

    const bodyBox = document.createElement('div');
    bodyBox.className = 'mmc-body';
    if (!ok) {
      bodyBox.innerHTML = `<div class="muted small">stopReason: ${escapeHtml(String(stopReason || '—'))}</div>
        <div class="muted small">reason: ${escapeHtml(String(error || '—'))}</div>
        <div class="muted small">Check <code>Output → Aether</code> for <code>[claude-mem]</code> lines.</div>`;
    } else {
      // 0.4.90 — worker generates async (LLM summarises the turn). Show a
      // "generating…" state right away with an animated dot; poll every
      // 3s in the background until at least one observation lands (or
      // 60s timeout — the user can still refresh manually). Once an
      // observation appears the badge flips to a check + the list expands.
      const startedAt = new Date().toLocaleTimeString();
      bodyBox.innerHTML = `
        <div class="mmc-status mmc-generating">
          <span class="mmc-dot"></span>
          <span>Generating observation… (queued ${escapeHtml(startedAt)})</span>
        </div>
        <button class="ghost-btn mmc-fetch" type="button" title="Refresh now">↻ Refresh</button>
        <div class="mmc-list"></div>`;
      const status = bodyBox.querySelector('.mmc-status');
      const btn = bodyBox.querySelector('.mmc-fetch');
      const list = bodyBox.querySelector('.mmc-list');

      let landed = false;
      let tries = 0;
      // 0.4.111 — bump to 40 × 3s = 2 min. Proxy container cold-start
      // takes ~30s on first reload, and 60s of polling was hitting the
      // "Load failed" branch before the worker HTTP was reachable.
      const MAX_TRIES = 40;

      const renderObs = (obs) => {
        list.innerHTML = obs.map(o => {
          const title = escapeHtml(String(o.title || o.content_type || 'observation'));
          // 0.4.126 — was `.slice(0, 320)` which chopped observation bodies
          // mid-sentence (e.g. "…External DRAM. Sta"). The card is inside a
          // collapsible <details>, so full text is fine — user opens it
          // deliberately.
          const body  = escapeHtml(String(o.content || ''));
          const type  = escapeHtml(String(o.content_type || '—'));
          const ts    = o.ts ? escapeHtml(new Date(o.ts).toLocaleString()) : '';
          return `<div class="mmc-obs"><div class="mmc-obs-hd">
            <span class="mmc-obs-t">${title}</span>
            <span class="muted small">${type} · ${ts}</span>
          </div><div class="mmc-obs-body muted small">${body}</div></div>`;
        }).join('');
      };

      // 0.4.114 — each card is anchored to the asst bubble whose turn
      // produced its summary. Pass the bubble's turnId so the backend can
      // load that turn's timestamp from JSONL and only return summaries
      // authored at or before that time — otherwise every card in a chat
      // shows every summary (screenshot 32). body.parentElement is the
      // .msg-assistant wrap; its data-turn-id was set by chat.asstTurn.
      const parentBubble = body?.closest ? body.closest('.msg-assistant') : null;
      const turnIdForCard = parentBubble?.dataset?.turnId
        ? Number(parentBubble.dataset.turnId)
        : undefined;
      const poll = async () => {
        tries++;
        try {
          const r = await rpc('memory.recent', {
            chatId, namespace: namespace || 'aura-ext',
            limit: 1,
            turnId: turnIdForCard,
          });
          if (r?.error) throw new Error(r.error);
          const obs = Array.isArray(r?.observations) ? r.observations : [];
          if (obs.length) {
            landed = true;
            status.innerHTML = `<span>Observation saved · ${escapeHtml(String(obs.length))} in project</span>`;
            status.classList.remove('mmc-generating');
            status.classList.add('mmc-landed');
            btn.textContent = '↻ Refresh';
            renderObs(obs);
            return;
          }
          // Worker reachable but no observations yet — LLM may still be summarizing.
          // After 10 tries (30s) with consistent empty: worker likely has nothing to save.
          if (tries >= 10) {
            landed = true;
            status.innerHTML = `<span>No observations for this turn.</span>`;
            status.classList.remove('mmc-generating');
            return;
          }
          if (tries < MAX_TRIES) setTimeout(poll, 3000);
          else {
            status.innerHTML = `<span>Still generating after 2 min — click ↻ to check again.</span>`;
            status.classList.remove('mmc-generating');
          }
        } catch (e) {
          // 0.4.111 — soften the "container not running" message: after a
          // window reload the proxy is still cold-starting and this error
          // fires every 3s until it's up. Show a "waiting for proxy" hint
          // in the status line so the user knows we're not dead — the
          // actual "Load failed" red line only appears after MAX_TRIES.
          const msg = String(e?.message || e || '');
          const cold = /container.*not running|proxy.*not|Connection refused|ECONNREFUSED/i.test(msg);
          if (cold && !landed) {
            status.innerHTML = `<span class="mmc-dot"></span><span>Waiting for proxy container (${tries}/${MAX_TRIES})…</span>`;
          }
          if (tries < MAX_TRIES) setTimeout(poll, 3000);
          else list.innerHTML = `<div class="muted small">Load failed: ${escapeHtml(msg)}</div>`;
        }
      };

      btn.onclick = () => {
        // Manual refresh: reset counter, drop back into polling state.
        tries = 0;
        landed = false;
        status.innerHTML = `<span class="mmc-dot"></span><span>Refreshing…</span>`;
        status.classList.add('mmc-generating');
        status.classList.remove('mmc-landed');
        poll();
      };

      // Kick off the first poll after a short delay to give the worker
      // a head start (LLM inference takes 2-10s for a small turn).
      // 0.4.193 — on reload the worker has almost certainly finished
      // already; poll immediately so a card that landed in a prior
      // session doesn't flash "Generating…" for 2.5s before flipping.
      if (stopReason === 'reload') poll();
      else setTimeout(poll, 2500);
    }
    card.appendChild(bodyBox);

    const strip = getOrCreateArtifactStrip(body);
    if (strip) {
      strip.appendChild(card);
      // 0.4.146 — force the strip to be the last child of body. Reload
      // path inserts file cards via absorbToolResultIntoLast which
      // body.appendChild() them; if the strip was created earlier (empty),
      // the file card ends up AFTER the strip and the memcard visually
      // sits above the file card. Move strip back to the end so the
      // memcard always trails the last artifact (screenshot #63: memcard
      // was appearing between iter-1 bubble's file card and iter-2's
      // duplicate text).
      body.appendChild(strip);
    } else {
      body.appendChild(card);
    }
  }

  /** 0.4.319 — render visualise HTML inline into `holder` (a plain div in the
   *  webview DOM), instead of a sandboxed iframe that can't be auto-sized.
   *
   *  Steps:
   *    1. Extract <style> blocks and scope every rule to this holder so the
   *       diagram's CSS can't leak into the rest of the chat UI.
   *    2. Extract the <body> inner HTML, strip <script> + inline on* handlers
   *       (CSP blocks them anyway), and convert onclick="show('id')" chips to
   *       data-show="id" so we can bind real click listeners.
   *    3. Parse the `details` map from the file's script and, on chip click,
   *       render the same detail panel the original page would have shown. */
  function renderVisualiseInline(html, holder, attempt = 0) {
    if (!holder.isConnected && attempt < 30) {
      requestAnimationFrame(() => renderVisualiseInline(html, holder, attempt + 1));
      return;
    }
    const vid = holder.dataset.visualiseId || '';

    // Bake the parent VS Code theme into the blob document. Blob iframes do
    // not inherit this webview's CSS variables/color-scheme, so relying on
    // prefers-color-scheme or template defaults can white-flash live artifacts.
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const bg = v('--bg', v('--vscode-editor-background', '#1f232b'));
    const bg2 = v('--surface', v('--vscode-sideBar-background', bg));
    const bg3 = v('--surface-3', v('--vscode-editorWidget-background', bg));
    const frameBg = 'color-mix(in srgb, ' + bg + ' 88%, white 12%)';
    const fg = v('--fg', v('--vscode-editor-foreground', '#e8e9ec'));
    const muted = v('--fg-muted', v('--vscode-descriptionForeground', '#a0a6b0'));
    const border = v('--border', v('--vscode-panel-border', 'rgba(255,255,255,.12)'));
    const inject = `<style>:root{` +
      `color-scheme:dark;--bg:${frameBg}!important;--bg2:${bg2}!important;--bg3:${bg3}!important;` +
      `--fg:${fg}!important;--muted:${muted}!important;--border:${border}!important;` +
      `--color-background-primary:${frameBg}!important;--color-background-secondary:${bg2}!important;` +
      `--color-background-tertiary:${bg3}!important;--color-text-primary:${fg}!important;` +
      `--color-text-secondary:${muted}!important;}html,body{background:${frameBg}!important;color:${fg}!important;}` +
      `.bar,.track,.range,.scale,.meter,.progress,[class*=\"bar\"],[class*=\"track\"],[class*=\"range\"],[class*=\"scale\"]{color:#18202a!important;}` +
      `.bar *, .track *, .range *, .scale *, .meter *, .progress *, [class*=\"bar\"] *, [class*=\"track\"] *, [class*=\"range\"] *, [class*=\"scale\"] *{color:#18202a!important;text-shadow:0 1px 0 rgba(255,255,255,.35);}` +
      `</style>`;
    if (/<\/head>/i.test(html)) html = html.replace(/<\/head>/i, inject + '</head>');
    else html = inject + html;

    // Render via a contained blob: URL iframe — JS runs natively, clicks work.
    // Treat the iframe like a browser viewport: the chat block stays bounded,
    // the page scrolls internally, and Ctrl+wheel zooms content inside it.
    const zoomScript = `<script>(function(){var z=1;document.addEventListener('wheel',function(e){if(!e.ctrlKey)return;e.preventDefault();z=Math.max(0.25,Math.min(3,z+(e.deltaY<0?0.1:-0.1)));document.documentElement.style.zoom=String(z);},{passive:false});})();<\/script>`;
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, zoomScript + '</body>');
    else html += zoomScript;

    const blob = new Blob([html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);

    const wrapper = document.createElement('div');
    wrapper.className = 'art-html-viewport';

    const iframe = document.createElement('iframe');
    iframe.className = 'art-html-frame';
    iframe.name = 'vf-' + vid;
    iframe.dataset.visualiseId = vid;
    iframe.dataset.containedViewport = 'true';
    iframe.style.cssText = `width:100%;height:100%;border:0;display:block;background:${frameBg};`;
    iframe.src = blobUrl;

    // Keep the blob URL alive for the iframe's lifetime. VS Code webviews may
    // re-evaluate/reload an existing frame while later turns stream; revoking on
    // first load can leave older visualise frames as a blank white document until
    // the chat is reloaded and a fresh blob URL is minted.

    wrapper.appendChild(iframe);
    holder.appendChild(wrapper);
  }

  /** Collect CSS variable declarations from EVERY
   *  `@media(prefers-color-scheme:dark){…}` block's :root/html/body rules.
   *  Templates split their dark vars across multiple such blocks (base tokens
   *  in one, per-segment colors like --seg-*-bg in another), so we must scan
   *  all of them — reading only the first left segment colors at their bright
   *  light values, which looked over-saturated. Returns merged declaration
   *  text, or '' if the file has no dark media blocks. */
  function extractDarkRootVars(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const mediaRe = /@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/gi;
    let decls = '';
    let mm;
    while ((mm = mediaRe.exec(css)) !== null) {
      // Brace-match this media block's body.
      let braceStart = css.indexOf('{', mm.index);
      let depth = 1, j = braceStart + 1;
      while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
      const inner = css.slice(braceStart + 1, j - 1);
      const ruleRe = /(:root|html|body)[^{]*\{([^}]*)\}/gi;
      let rm;
      while ((rm = ruleRe.exec(inner)) !== null) decls += rm[2] + ';';
      mediaRe.lastIndex = j;
    }
    return decls;
  }


  function escapeToolContainer(insertAfter, body) {
    while (body && body !== els.threadInner && (
      body.classList?.contains('tool-card') ||
      body.classList?.contains('blk-tool-use') ||
      body.classList?.contains('blk-tool-result') ||
      body.tagName === 'DETAILS' ||
      body.tagName === 'SUMMARY'
    )) {
      insertAfter = body;
      body = body.parentNode;
    }
    return { insertAfter, body };
  }

  function adaptSvgArtifactFrame(node, svg) {
    const parseNum = (v) => {
      const n = parseFloat(String(v || '').replace(/px$/, ''));
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    let w = 0, h = 0;
    const vb = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && Number.isFinite(vb[2]) && Number.isFinite(vb[3])) {
      w = vb[2]; h = vb[3];
    }
    if (!w) w = parseNum(svg.getAttribute('width'));
    if (!h) h = parseNum(svg.getAttribute('height'));
    if (!w || !h) {
      try {
        const box = svg.getBBox();
        w = w || box.width;
        h = h || box.height;
      } catch { /* keep CSS fallback */ }
    }
    if (!w || !h) return;
    const maxW = Math.max(280, Math.min(960, (els.threadInner?.clientWidth || 960) - 64));
    const scale = Math.min(1, maxW / w);
    node.style.width = `${Math.ceil(w * scale) + 16}px`;
    svg.style.width = `${Math.ceil(w * scale)}px`;
    svg.style.height = `${Math.ceil(h * scale)}px`;
  }


  function artifactKey(a) {
    return String((a && (a.id || a.localPath || a.webviewUri || a.name)) || '');
  }

  function artifactLogicalKey(a) {
    const name = String((a && (a.name || a.filename)) || '').trim();
    if (name) return `name:${name.toLowerCase()}`;
    return `artifact:${artifactKey(a)}`;
  }

  function imageAttachKeys(payload) {
    const p = payload || {};
    const keys = new Set();
    const add = (kind, value) => {
      const v = String(value || '').trim();
      if (v) keys.add(`${kind}:${v}`);
    };
    add('id', p.id || p.artifactId);
    add('path', p.localPath || p.path);
    add('uri', p.webviewUri);
    add('name', p.name || p.filename);
    return [...keys];
  }

  function rememberImageAttach(payload) {
    state.attachedImageKeys = state.attachedImageKeys || new Set();
    const keys = imageAttachKeys(payload);
    if (keys.some(k => state.attachedImageKeys.has(k))) return false;
    keys.forEach(k => state.attachedImageKeys.add(k));
    return true;
  }

  function seedImageAttachKeysFromDom(root = els.threadInner) {
    state.attachedImageKeys = state.attachedImageKeys || new Set();
    root?.querySelectorAll?.('[data-image-attach-keys]').forEach(el => {
      String(el.dataset.imageAttachKeys || '').split('|').filter(Boolean).forEach(k => state.attachedImageKeys.add(k));
    });
  }

  function stampImageAttachKeys(node, payload) {
    const keys = imageAttachKeys(payload);
    if (keys.length) node.dataset.imageAttachKeys = keys.join('|');
  }

  function artifactDomExists(payload, root = els.threadInner) {
    if (!payload || !root) return false;
    return !!findArtifactDomDuplicate(payload, root);
  }

  function findArtifactDomDuplicate(payload, root = els.threadInner) {
    if (!payload || !root) return null;
    const id = payload.id || payload.artifactId;
    if (id) {
      const byId = root.querySelector?.(`[data-artifact-id="${cssEscape(String(id))}"]`);
      if (byId) return byId;
    }
    const logicalKey = artifactLogicalKey(payload);
    if (logicalKey) {
      const byKey = root.querySelector?.(`[data-artifact-key="${cssEscape(logicalKey)}"]`);
      if (byKey) return byKey;
    }
    const mtKey = String(payload.mediaType || '').toLowerCase();
    const nameKey = String(payload.name || payload.filename || '').trim().toLowerCase();
    const pathTail = String(payload.localPath || payload.path || '').split('/').pop()?.toLowerCase() || '';
    const sizeKey = Number(payload.size || 0);
    // The mediaType+size match below is a LAST RESORT for anonymous byte
    // broadcasts (no name, no path) surfaced under different ids. Only trust it
    // when the payload carries neither a name nor a path to distinguish by —
    // otherwise two genuinely different small files that happen to share a type
    // and exact byte size (e.g. two 72-byte JSON files, build.json vs data.json)
    // get wrongly collapsed and the second is dropped (never rendered).
    const canCoarseMatch = !nameKey && !pathTail;
    return [...(root.querySelectorAll?.('.art-image,.art-html-card,.art-file,.msg-image-wrap,.msg-file-card') || [])].find(el => {
      const imgAlt = String(el.querySelector('img')?.getAttribute('alt') || '').trim().toLowerCase();
      const titleText = String(el.querySelector('.art-html-name,.art-file-name,.mfc-name')?.textContent || '').trim().toLowerCase();
      const pathText = String(el.querySelector('.art-image-path,.art-html-path,.art-file-path,.mfc-path')?.textContent || '').toLowerCase();
      const elMt = String(el.dataset.mediaType || '').toLowerCase();
      const elSize = Number(el.dataset.artifactSize || 0);
      if (nameKey && (imgAlt === nameKey || titleText === nameKey || String(el.title || '').trim().toLowerCase() === nameKey)) return true;
      if (pathTail && pathText.endsWith('/' + pathTail)) return true;
      return canCoarseMatch && mtKey && sizeKey > 0 && elMt === mtKey && elSize === sizeKey;
    }) || null;
  }

  function removeGenericArtifactDuplicate(payload, root = els.threadInner) {
    const id = String(payload?.id || payload?.artifactId || '');
    const dupe = findArtifactDomDuplicate(payload, root);
    if (!dupe) return;
    if (id && String(dupe.dataset?.artifactId || '') === id) return;
    dupe.remove();
  }

  function sortArtifacts(list, mode = state.artifactGallerySort) {
    const out = (list || []).slice();
    if (mode === 'oldest') return out.sort((a, b) => (Number(a.savedAt) || 0) - (Number(b.savedAt) || 0));
    if (mode === 'name') return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (mode === 'size') return out.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    return out.sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));
  }

  function latestArtifacts(list) {
    const byKey = new Map();
    for (const item of list || []) {
      if (!item) continue;
      const key = artifactLogicalKey(item);
      const prev = byKey.get(key);
      const prevTime = Number(prev && prev.savedAt) || 0;
      const nextTime = Number(item.savedAt) || 0;
      if (!prev || nextTime >= prevTime) byKey.set(key, item);
    }
    return sortArtifacts(Array.from(byKey.values()));
  }

  function rememberArtifact(payload) {
    const chatId = String((payload && payload.chatId) || '');
    const key = artifactLogicalKey(payload);
    if (!chatId || !key) return;
    const list = state.artifactsByChat.get(chatId) || [];
    const idx = list.findIndex(a => artifactLogicalKey(a) === key);
    const next = { ...(idx >= 0 ? list[idx] : {}), ...payload };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    state.artifactsByChat.set(chatId, latestArtifacts(list));
    if (next.live && next.id) ensureLiveArtifactPolling(next);
    updateArtifactGalleryBadge();
    if (chatId === state.activeChatId && state.artifactGalleryOpen) renderArtifactGallery();
  }

  function mergeRememberedArtifact(payload) {
    const chatId = String((payload && payload.chatId) || '');
    const key = artifactLogicalKey(payload);
    if (!chatId || !key) return false;
    const list = state.artifactsByChat.get(chatId) || [];
    const idx = list.findIndex(a => artifactLogicalKey(a) === key);
    const prev = idx >= 0 ? list[idx] : null;
    const next = { ...(prev || {}), ...payload };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    state.artifactsByChat.set(chatId, latestArtifacts(list));
    updateArtifactGalleryBadge();
    return JSON.stringify(prev || {}) !== JSON.stringify(next);
  }

  async function refreshOpenArtifactPreview(payload) {
    const chatId = String(payload?.chatId || '');
    const id = String(payload?.id || '');
    if (!chatId || !id) return;
    const targets = [..._artifacts.entries()].filter(([, a]) => String(a.artifactId || '') === id && String(a.chatId || '') === chatId);
    if (!targets.length) return;
    const agentId = payload?.agentId || payload?.sourceAgentId || state.activeAgentId || undefined;
    const r = await rpc('artifact.preview', { chatId, id, agentId });
    if (!r || r.error) throw new Error((r && r.error) || 'preview failed');
    for (const [tabId, a] of targets) {
      a.kind = r.kind || a.kind || 'text';
      a.source = r.source || r.html || r.text || '';
      a.data = r.data;
      a.text = r.text;
      a.lang = r.lang;
      a.delimiter = r.delimiter;
      a.filename = r.filename || a.filename;
      a.version = payload.version;
      a.updatedAt = payload.updatedAt;
      a.mediaType = payload.mediaType || a.mediaType;
      a.live = true;
      if (tabId === _activeArtifactId) selectArtifact(tabId);
    }
  }

  function onArtifactUpdated(payload) {
    if (!payload || !payload.chatId || !payload.id) return;
    mergeRememberedArtifact({ ...payload, live: true });
    // Attach FIRST so this turn's card exists, THEN flash it. Flashing before
    // attach would find no scoped card (toolUseId match returns null) and skip
    // the highlight — or, worse under a loose match, flash a previous turn.
    onArtifactAttach({ ...payload, live: true });
    refreshArtifactCard(payload, true);
    refreshOpenArtifactPreview(payload).catch(e => console.warn('[studio] artifact preview refresh failed:', e));
    if (payload.chatId === state.activeChatId && state.artifactGalleryOpen) renderArtifactGallery();
  }

  function ensureLiveArtifactPolling(a) {
    const chatId = String(a.chatId || state.activeChatId || '');
    const id = String(a.id || '');
    if (!chatId || !id) return;
    const key = `${chatId}:${id}`;
    if (state.liveArtifactTimers.has(key)) return;
    let stopped = false;
    let fails = 0;
    let lastVersion = Number(a.version || 1);
    const stopAt = Date.now() + 10 * 60_000;
    const tick = async () => {
      if (stopped) return;
      if (Date.now() > stopAt) { markLiveArtifactState(id, 'idle'); state.liveArtifactTimers.delete(key); return; }
      try {
        const r = await rpc('artifact.meta', { chatId, id });
        if (!r || r.error) throw new Error((r && r.error) || 'meta failed');
        const meta = r.artifact || {};
        mergeRememberedArtifact({ ...meta, chatId, live: true });
        const version = Number(meta.version || 1);
        if (version !== lastVersion) {
          lastVersion = version;
          // meta.toolUseId is the OLDEST turn's anchor; polling means "the live
          // card", so drop it and let refreshArtifactCard target the most-recent
          // card (document order → the live one).
          const next = { ...meta, chatId, live: true, toolUseId: undefined };
          refreshArtifactCard(next, true);
          refreshOpenArtifactPreview(next).catch(e => console.warn('[studio] artifact polling preview refresh failed:', e));
        } else {
          markLiveArtifactState(id, 'live');
        }
        fails = 0;
      } catch (e) {
        fails++;
        if (fails >= 3) { markLiveArtifactState(id, 'disconnected'); state.liveArtifactTimers.delete(key); return; }
      }
      const t = setTimeout(tick, 3000);
      state.liveArtifactTimers.set(key, { timer: t, stop: () => { stopped = true; clearTimeout(t); } });
    };
    const t = setTimeout(tick, 3000);
    state.liveArtifactTimers.set(key, { timer: t, stop: () => { stopped = true; clearTimeout(t); } });
    markLiveArtifactState(id, 'live');
  }

  // Per-turn artifact cards share the same data-artifact-id. Scope card lookups
  // to the originating tool_use so an update to turn N never rewrites (or moves)
  // the card that turn N-1 pinned. When a toolUseId is given we match it
  // EXACTLY (or return null) — never fall back to another turn's card. Only the
  // unscoped path (live-file polling of "the current card") targets the
  // most-recent card, which in document order is the live one.
  function artifactCardNode(id, toolUseId) {
    const root = els.threadInner;
    if (!root) return null;
    const idSel = cssEscape(String(id));
    if (toolUseId) {
      return root.querySelector(
        `[data-artifact-id="${idSel}"][data-tool-use-id="${cssEscape(String(toolUseId))}"]`
      );
    }
    const all = root.querySelectorAll(`[data-artifact-id="${idSel}"]`);
    return all.length ? all[all.length - 1] : null;
  }

  function markLiveArtifactState(id, stateName, toolUseId) {
    const node = artifactCardNode(id, toolUseId);
    if (!node) return;
    node.classList.toggle('is-live', stateName === 'live' || stateName === 'updated');
    node.classList.toggle('is-updated', stateName === 'updated');
    node.classList.toggle('is-disconnected', stateName === 'disconnected');
    const badge = node.querySelector('.art-live-badge');
    if (badge) badge.textContent = stateName === 'disconnected' ? 'disconnected' : stateName === 'idle' ? 'idle' : 'live';
  }

  function refreshArtifactCard(payload, flash = false) {
    if (!payload || payload.chatId !== state.activeChatId || !payload.id) return;
    const tid = payload.toolUseId;
    const node = artifactCardNode(payload.id, tid);
    if (!node) return;
    const sizeEl = node.querySelector('.art-file-size');
    if (sizeEl) sizeEl.textContent = [artFmtBytes(Number(payload.size || 0)), artFmtTime(payload.updatedAt || payload.savedAt)].filter(Boolean).join(' · ');
    if (flash) {
      markLiveArtifactState(payload.id, 'updated', tid);
      setTimeout(() => markLiveArtifactState(payload.id, 'live', tid), 1200);
    }
  }

  function updateArtifactGalleryBadge() {
    const count = (state.artifactsByChat.get(state.activeChatId) || []).length;
    if (els.artifactGalleryBadge) {
      els.artifactGalleryBadge.textContent = String(count);
      els.artifactGalleryBadge.hidden = count === 0;
    }
  }

  async function refreshArtifactGallery() {
    if (!state.activeChatId) { updateArtifactGalleryBadge(); renderArtifactGallery(); return; }
    try {
      const r = await rpc('artifacts.list', { chatId: state.activeChatId });
      const artifacts = Array.isArray(r && r.artifacts) ? r.artifacts : [];
      state.artifactsByChat.set(state.activeChatId, latestArtifacts(artifacts.map(a => ({ ...a, chatId: state.activeChatId }))));
    } catch (e) {
      console.warn('[studio] artifacts.list failed:', e);
    }
    updateArtifactGalleryBadge();
    if (state.artifactGalleryOpen) renderArtifactGallery();
  }

  async function previewArtifactEntry(a) {
    const localPath = a && a.localPath;
    const agentId = a.agentId || a.sourceAgentId || state.activeAgentId || undefined;
    if (!localPath && !a?.id) return;
    const r = a.id ? await rpc('artifact.preview', { chatId: state.activeChatId, id: a.id, agentId }) : await rpc('file.preview', { path: localPath });
    if (!r || r.error) throw new Error((r && r.error) || 'preview failed');
    const artId = addArtifact({
      kind: r.kind || 'text', title: a.name || a.id || 'artifact',
      source: r.source || r.html || r.text || '', path: r.path || localPath || a.name || a.id,
      data: r.data, text: r.text, lang: r.lang, delimiter: r.delimiter, filename: r.filename || a.name,
      artifactId: a.id, chatId: state.activeChatId, mediaType: a.mediaType, live: a.live,
      version: a.version, updatedAt: a.updatedAt,
    });
    selectArtifact(artId); openArtifactPanel();
  }

  function renderArtifactGallery() {
    if (!els.artifactGallery || !els.artifactGalleryList) return;
    const list = sortArtifacts(state.artifactsByChat.get(state.activeChatId) || []);
    if (els.artifactGallerySort) els.artifactGallerySort.value = state.artifactGallerySort;
    if (els.artifactGallerySub) els.artifactGallerySub.textContent = `${list.length} file${list.length === 1 ? '' : 's'} in this chat`;
    els.artifactGalleryList.innerHTML = '';

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'artifact-gallery-empty';
      empty.textContent = 'No saved file artifacts for this chat yet.';
      els.artifactGalleryList.appendChild(empty);
      return;
    }
    for (const a of list) {
      const row = document.createElement('div');
      row.className = 'artifact-gallery-row';
      row.dataset.artifactId = a.id || '';
      const icon = document.createElement('div');
      icon.className = 'artifact-gallery-icon';
      icon.textContent = (String(a.mediaType || '').startsWith('image/')) ? '🖼' : artFileIcon(a.name || a.localPath || '');
      const meta = document.createElement('div');
      meta.className = 'artifact-gallery-meta';
      const name = document.createElement('div');
      name.className = 'artifact-gallery-name';
      name.textContent = a.name || a.id || 'artifact';
      const sub = document.createElement('div');
      sub.className = 'artifact-gallery-detail';
      sub.textContent = [a.mediaType || '', artFmtBytes(Number(a.size || 0))].filter(Boolean).join(' · ');
      const when = document.createElement('div');
      when.className = 'artifact-gallery-time';
      when.textContent = artFmtTime(a.savedAt) || 'time not recorded';
      meta.appendChild(name); meta.appendChild(sub); meta.appendChild(when);
      const actions = document.createElement('div');
      actions.className = 'artifact-gallery-actions';
      const preview = document.createElement('button');
      preview.type = 'button'; preview.className = 'btn'; preview.textContent = 'Preview';
      preview.addEventListener('click', async () => {
        try { await previewArtifactEntry(a); }
        catch (e) { showToast('Preview failed: ' + (e && e.message || e), 'error', 5000); }
      });
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'btn'; save.textContent = 'Save As';
      save.addEventListener('click', () => saveAsDownload({ id: a.id, chatId: state.activeChatId, agentId: a.agentId || a.sourceAgentId || state.activeAgentId || undefined, path: a.localPath || '' }));
      actions.appendChild(preview); actions.appendChild(save);
      row.appendChild(icon); row.appendChild(meta); row.appendChild(actions);
      els.artifactGalleryList.appendChild(row);
    }
  }

  function openArtifactGallery() {
    state.artifactGalleryOpen = true;
    if (els.artifactGallery) els.artifactGallery.hidden = false;
    refreshArtifactGallery();
  }

  function closeArtifactGallery() {
    state.artifactGalleryOpen = false;
    if (els.artifactGallery) els.artifactGallery.hidden = true;
  }

  /** v0.4.259 — id-based artifact render for sandbox tool_result files.
   *
   *  SPOKE/HUB NOTE: this handler currently resolves `webviewUri` from a
   *  host-local `localPath`. Under the future spoke-and-hub model the
   *  spoke will fetch bytes from the hub over HTTP using `artifact.id`
   *  as the sole address. Everything else in the render code stays the
   *  same — only the byte source changes. Swap point: replace the
   *  `<img src={webviewUri}>` / `rpc('artifact.getText', {chatId, id})`
   *  paths with a `resolveArtifactSrc(id)` helper that returns either a
   *  webview URI (local) or an authenticated hub URL (spoke). */
  function hasRenderedAgentHandoff(agentId) {
    if (!agentId) return false;
    return [...els.threadInner.querySelectorAll('.msg-agent-handoff')].some(el =>
      String(el.textContent || '').includes(String(agentId))
    );
  }

  function onArtifactAttach(payload, _retry = 0, _gen = state.loadGen, _viewGen = state.agentViewGen) {
    const { chatId, id, name, mediaType, localPath, webviewUri, size, toolUseId,
            sourceUrl, containerPath, isExcalidrawSnapshot, turnId } = payload || {};
    const payloadAgentId = payload?.agentId || payload?.sourceAgentId;
    if (!chatId || chatId !== state.activeChatId) { if (_retry === 0) dbg(`onArtifactAttach SKIP chatId ${chatId}!==${state.activeChatId} id=${id}`); return; }
    if (state.activeAgentId && payloadAgentId && payloadAgentId !== state.activeAgentId) { if (_retry === 0) dbg(`onArtifactAttach SKIP agentId ${payloadAgentId}!==${state.activeAgentId} id=${id}`); return; }
    if (!id) return;
    rememberArtifact(payload);
    // Abort stale retries from a previous loadChat or agent-thread invocation.
    if (_gen !== state.loadGen) { if (_retry === 0) dbg(`onArtifactAttach SKIP gen ${_gen}!==${state.loadGen} id=${id}`); return; }
    if (_viewGen !== state.agentViewGen) { if (_retry === 0) dbg(`onArtifactAttach SKIP agentViewGen ${_viewGen}!==${state.agentViewGen} id=${id}`); return; }

    const hasAgentHandoff = payloadAgentId && hasRenderedAgentHandoff(payloadAgentId);
    const fromSpawnResult = !!payload?.fromSpawnResult;
    const allowToolAnchor = !payloadAgentId || payloadAgentId === state.activeAgentId || (!state.activeAgentId && (hasAgentHandoff || fromSpawnResult));
    if (!state.activeAgentId && payloadAgentId && !hasAgentHandoff && !fromSpawnResult) {
      if (_retry === 0) dbg(`onArtifactAttach DEFER pending agent handoff source=${payloadAgentId} id=${id}`);
      return;
    }

    // Anchor + retry. v0.4.299 — retry ONLY on the .blk-tool-use anchor.
    // The old gate `!anchor || !result` also required a
    // .blk-tool-result[data-tool-use-id] to exist before rendering. On the
    // reload/switch path the tool_result block for a save_visualise call is
    // absorbed from the FOLLOWING user turn and — depending on how it was
    // persisted — may never carry data-tool-use-id. That made `result` never
    // resolve, so after 60 empty retries the artifact was dropped entirely
    // (this is the "switch session → visualise disappears" bug). The result
    // block is only needed for *placement* (insert after it); its absence
    // must fall through to the tool_use anchor, not abort the render.
    if (toolUseId && allowToolAnchor) {
      const anchor = els.threadInner.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
      );
      if (!anchor) {
        // Anchor not painted yet — retry for ~0.5 s (30 frames). If it still
        // hasn't appeared, fall through to the bubble-tail fallback below so
        // the artifact renders somewhere rather than vanishing.
        if (_retry < 30) { requestAnimationFrame(() => onArtifactAttach(payload, _retry + 1, _gen, _viewGen)); return; }
      }
    }

    const logicalKey = artifactLogicalKey(payload);
    // Persisted/live aura_artifact blocks render an invisible anchor inside the
    // aura_artifact_pin tool card. Prefer that anchor so SSE and reload both
    // render the artifact as part of the pin card, after the pin result.
    const artifactAnchor = (() => {
      if (toolUseId) {
        return els.threadInner.querySelector(
          `.aura-artifact-anchor[data-aura-artifact-id="${cssEscape(String(id))}"][data-tool-use-id="${cssEscape(String(toolUseId))}"]`
        );
      }
      return els.threadInner.querySelector(`[data-aura-artifact-id="${cssEscape(String(id))}"]`);
    })();
    const liveToolResultAnchor = !artifactAnchor && toolUseId && !fromSpawnResult
      ? els.threadInner.querySelector(`.blk-tool-result[data-tool-use-id="${cssEscape(String(toolUseId))}"]`)
      : null;
    if (toolUseId && !fromSpawnResult && !artifactAnchor && !liveToolResultAnchor && _retry < 120) {
      requestAnimationFrame(() => onArtifactAttach(payload, _retry + 1, _gen, _viewGen));
      return;
    }

    // If a generic sandbox/static card for the same file rendered first, the
    // explicit pin must win and move the visual render to the pin anchor.
    if (artifactAnchor) removeGenericArtifactDuplicate(payload);

    // Per-turn pinning: each turn's pin/update owns its OWN card, anchored to
    // its tool_use. When this attach carries a toolUseId, only reconcile the
    // card that belongs to the SAME tool_use — never move or remove a card that
    // an earlier turn pinned (that erased history: turn N-1's card jumped down
    // under turn N's tool). A new toolUseId falls through to render a fresh card.
    if (toolUseId) {
      const sameTurnCard = els.threadInner?.querySelector?.(
        `[data-artifact-id="${cssEscape(String(id))}"][data-tool-use-id="${cssEscape(String(toolUseId))}"]`
      );
      if (sameTurnCard) { refreshArtifactCard(payload, false); return; }
      // Collapse a DIFFERENT-id card of the SAME logical file AND SAME bytes.
      // Sub-agents auto-capture a sandbox output (one artifact id) and then
      // explicitly aura_artifact_pin the same bytes (a second id) — that's one
      // file, so the explicit pin must REPLACE the auto-capture card, not stack
      // beside it. Match name+size (not name alone): a file that was edited and
      // re-pinned in a later turn has the same name but a DIFFERENT size, and
      // must be KEPT as its own card (per-turn history). Same-id cards are the
      // update path (same id, new toolUseId) and never reach here — the branch
      // above returns first.
      const sizeKey = String(Number(size || 0));
      els.threadInner?.querySelectorAll?.(
        `[data-artifact-key="${cssEscape(logicalKey)}"]`
      ).forEach(el => {
        if (String(el.dataset.artifactId || '') === String(id)) return;
        if (String(el.dataset.artifactSize || '0') !== sizeKey) return;
        el.remove();
      });
    } else {
      // No tool anchor (root/agent broadcast, excalidraw): keep the legacy
      // single-card dedup so those paths don't regress into duplicates.
      const existingArtifact = els.threadInner?.querySelector?.(
        `[data-artifact-id="${cssEscape(String(id))}"], [data-artifact-key="${cssEscape(logicalKey)}"]`
      );
      if (existingArtifact) {
        const existingCard = existingArtifact.closest?.('.tool-card');
        const targetCard = (artifactAnchor || liveToolResultAnchor)?.closest?.('.tool-card');
        if (targetCard && existingCard !== targetCard) {
          existingArtifact.remove();
        } else {
          refreshArtifactCard(payload, false);
          return;
        }
      }
    }

    // Older persisted/live runs may already have a generic sandbox/file card for
    // the same output. Without an explicit pin/update anchor, keep the first
    // render. If the current tool_result is visible, render again here so live
    // SSE update_artifact does not wait for reload just because the same id/path
    // already appeared in an earlier pin/update card.
    if (!artifactAnchor && !liveToolResultAnchor && artifactDomExists(payload)) return;

    // Prefer inserting IMMEDIATELY after the aura_artifact anchor. If this is a
    // parent spawn_agents artifact ref (no aura_artifact block in the parent),
    // fall back to the tool_result/tool_use for placement.
    let insertAfter = null;
    let body = null;
    if (artifactAnchor) {
      insertAfter = artifactAnchor;
      body = artifactAnchor.parentNode;
    }
    if (!body && toolUseId && allowToolAnchor) {
      const anchorResult = els.threadInner.querySelector(
        `.blk-tool-result[data-tool-use-id="${cssEscape(String(toolUseId))}"]`
      );
      if (anchorResult) {
        insertAfter = anchorResult.closest('[data-blk-idx]') || anchorResult;
        body = insertAfter.parentNode;
        if (fromSpawnResult) {
          const escaped = escapeToolContainer(insertAfter, body);
          insertAfter = escaped.insertAfter;
          body = escaped.body;
        }
      } else {
        const anchorTool = els.threadInner.querySelector(
          `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
        );
        if (anchorTool) {
          insertAfter = anchorTool.closest('[data-blk-idx]') || anchorTool;
          body = insertAfter.parentNode;
          if (fromSpawnResult) {
            const escaped = escapeToolContainer(insertAfter, body);
            insertAfter = escaped.insertAfter;
            body = escaped.body;
          }
        }
      }
    }
    if (!body && state.activeAgentId && turnId !== undefined && turnId !== null) {
      const turnBubble = els.threadInner.querySelector(
        `.msg-assistant[data-agent-id="${cssEscape(state.activeAgentId)}"][data-turn-id="${cssEscape(String(turnId))}"]`
      );
      body = turnBubble?.querySelector(':scope > .msg-body') || turnBubble || null;
    }
    if (!state.activeAgentId && payloadAgentId && body && !body.closest('.msg-agent-handoff') && !hasAgentHandoff && !fromSpawnResult) {
      if (_retry === 0) dbg(`onArtifactAttach DEFER non-handoff body for source=${payloadAgentId} id=${id}`);
      return;
    }
    // Agent thread views are scoped. A root/orchestrator artifact broadcast can
    // arrive while the user is viewing a leaf; if it has no explicit agent id
    // and no anchor in the current transcript, do not append it to the leaf's
    // last bubble. Reload has the persisted root turn and will place it there.
    if (!body && state.activeAgentId && !payloadAgentId) {
      if (_retry === 0) dbg(`onArtifactAttach DEFER unscoped artifact in agent view id=${id}`);
      return;
    }
    if (!body) {
      const sel = state.activeAgentId
        ? `.msg-assistant[data-agent-id="${cssEscape(state.activeAgentId)}"]`
        : `.msg-assistant[data-chat-id="${cssEscape(chatId)}"]`;
      const bubbles = els.threadInner.querySelectorAll(sel);
      let target = null;
      if (isExcalidrawSnapshot && turnId !== undefined && turnId !== null) {
        target = els.threadInner.querySelector(
          state.activeAgentId
            ? `.msg-assistant[data-agent-id="${cssEscape(state.activeAgentId)}"][data-turn-id="${cssEscape(String(turnId))}"]`
            : `.msg-assistant[data-chat-id="${cssEscape(chatId)}"][data-turn-id="${cssEscape(String(turnId))}"]`
        );
      }
      if (!target) target = bubbles[bubbles.length - 1];
      if (isExcalidrawSnapshot && !target) {
        for (let i = bubbles.length - 1; i >= 0; i--) {
          if (!bubbles[i].querySelector('.msg-memory-card')) { target = bubbles[i]; break; }
        }
      }
      if (!target) return;
      body = target.querySelector('.msg-body') || target;
    }

    const mt = String(mediaType || '');
    let node;
    if (mt === 'image/svg+xml') {
      // Inline SVG for visual render. Fetch text from backend so we can
      // strip <script> before injecting into the DOM.
      node = document.createElement('div');
      node.className = 'art-svg';
      node.dataset.artifactId = id;
      node.textContent = '⏳ loading svg…';
      const loadSvg = (attempt) => {
        rpc('artifact.getText', { chatId, id, agentId: payloadAgentId || undefined }).then(r => {
          const txt = String((r && r.text) || '');
          if (!txt && attempt < 8) {
            setTimeout(() => loadSvg(attempt + 1), 300 * attempt);
            return;
          }
          if (!txt) { node.textContent = 'SVG load failed'; return; }
          // Basic sanitize: strip <script>…</script> and inline event handlers.
          const safe = txt
            .replace(/<script\b[\s\S]*?<\/script>/gi, '')
            .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
            .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
          node.innerHTML = safe;
          const svg = node.querySelector('svg');
          if (svg) adaptSvgArtifactFrame(node, svg);
          if (isExcalidrawSnapshot && svg) {
            node.classList.add('excalidraw-snapshot');
            // Excalidraw exports carry their own light canvas palette. Keep it
            // instead of applying the generic dark SVG reskin that can turn the
            // whole snapshot into an empty black rectangle.
            node.style.background = '#ffffff';
            svg.style.background = '#ffffff';
            const zoomBtn = document.createElement('button');
            zoomBtn.type = 'button';
            zoomBtn.className = 'art-svg-zoom';
            zoomBtn.setAttribute('data-act', 'zoomArtSvg');
            zoomBtn.title = 'Zoom';
            zoomBtn.setAttribute('aria-label', 'Zoom SVG');
            zoomBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
            node.appendChild(zoomBtn);
          }
        }).catch(e => {
          if (attempt < 8) setTimeout(() => loadSvg(attempt + 1), 300 * attempt);
          else node.textContent = `SVG load failed: ${e && e.message ? e.message : e}`;
        });
      };
      loadSvg(1);
    } else if (mt === 'text/html') {
      // 0.4.286 — two paths:
      //   isVisualise=true  → save_visualise MCP: file on disk with dark CSS +
      //                       resize script already baked in. Use frame.src so
      //                       the file is loaded directly — no srcdoc injection,
      //                       no artifact.getText RPC, survives webview reload.
      //   isVisualise=false → HTML from sandbox or other tools: show preview
      //                       card only (header + path + open button, no iframe).
      node = document.createElement('figure');
      node.className = 'art-html-card';
      node.dataset.artifactId = id;

      const header = document.createElement('div');
      header.className = 'art-html-header';
      const nameEl = document.createElement('div');
      nameEl.className = 'art-html-name';
      nameEl.textContent = name || id;
      nameEl.title = name || id;
      const openExtBtn = document.createElement('button');
      openExtBtn.type = 'button';
      openExtBtn.className = 'btn';
      openExtBtn.textContent = 'Open in browser';
      openExtBtn.addEventListener('click', async () => {
        if (sourceUrl) { try { await rpc('openExternal', { url: sourceUrl }); } catch {} }
      });
      if (!sourceUrl) openExtBtn.style.display = 'none';
      const previewBtn = document.createElement('button');
      previewBtn.type = 'button';
      previewBtn.className = 'btn';
      previewBtn.textContent = 'Preview';
      previewBtn.addEventListener('click', async () => {
        try { await previewArtifactEntry({ ...payload, chatId, id, localPath, name, mediaType: mt, agentId: payloadAgentId || undefined }); }
        catch (e) { showToast('Preview failed: ' + (e && e.message || e), 'error', 5000); }
      });
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn';
      saveBtn.textContent = 'Save As';
      saveBtn.addEventListener('click', () => saveAsDownload({ id, chatId, agentId: payloadAgentId || undefined, path: localPath || '' }));
      header.appendChild(nameEl);
      header.appendChild(openExtBtn);
      header.appendChild(previewBtn);
      header.appendChild(saveBtn);

      const pathRow = document.createElement('div');
      pathRow.className = 'art-html-paths';
      if (localPath) {
        const local = document.createElement('div');
        local.className = 'art-html-path';
        local.textContent = 'local: ' + localPath;
        local.title = localPath;
        pathRow.appendChild(local);
      }
      if (containerPath || sourceUrl) {
        const remote = document.createElement('div');
        remote.className = 'art-html-path';
        const rt = containerPath ? `container: ${containerPath}` : `url: ${sourceUrl}`;
        remote.textContent = rt;
        remote.title = sourceUrl || containerPath;
        pathRow.appendChild(remote);
      }

      // Pinned HTML artifacts render inline from artifact storage. The artifact id
      // is the source of truth; webviewUri is optional for agent/root parity.
      if (payload.isVisualise || mt === 'text/html') {
        // 0.4.319 — render the visualise HTML DIRECTLY into a div, NOT an
        // iframe. A sandboxed srcdoc iframe (allow-scripts, null origin) in
        // this VS Code webview blocks BOTH postMessage-to-parent AND
        // parent-reads-contentDocument, so the iframe could never be sized to
        // its content (stuck at the 200px placeholder, internal scroll).
        // Rendering inline lets the block flow to its natural height — no
        // measuring needed. The file's <script> is stripped (CSP would block
        // it anyway); interactivity (detail panels) is re-bound from here by
        // parsing the `details` map and wiring clicks via addEventListener.
        const holder = document.createElement('div');
        holder.className = 'art-html-render';
        holder.dataset.visualiseId = id;
        const loadHtml = (attempt) => {
          rpc('artifact.getText', { chatId, id, agentId: payloadAgentId || undefined }).then(r => {
            const html = String((r && r.text) || '');
            if (!html && attempt < 8) {
              setTimeout(() => loadHtml(attempt + 1), 300 * attempt);
              return;
            }
            if (!html) { holder.textContent = 'HTML load failed'; return; }
            renderVisualiseInline(html, holder);
          }).catch(() => {
            if (attempt < 8) setTimeout(() => loadHtml(attempt + 1), 300 * attempt);
            else holder.textContent = 'HTML load failed';
          });
        };
        loadHtml(1);
        node.appendChild(header);
        if (pathRow.childElementCount) node.appendChild(pathRow);
        node.appendChild(holder);
      } else {
        // Non-visualise HTML (sandbox output, etc.) — preview card only.
        // No iframe: we don't know the theme/safety of arbitrary HTML.
        // Header already has Preview/Save As buttons wired through artifact id
        // and agentId above. Do not add a second root-only file.preview button:
        // agent-scoped HTML lives under chat-artifacts/<chatId>/agent-<id>/... .
        node.appendChild(header);
        if (pathRow.childElementCount) node.appendChild(pathRow);
      }
    } else if (mt.startsWith('image/')) {
      node = document.createElement('div');
      node.className = 'art-image';
      node.dataset.artifactId = id;
      node.dataset.artifactKey = logicalKey;
      stampImageAttachKeys(node, payload);
      const img = document.createElement('img');
      img.src = webviewUri;
      img.alt = name || 'artifact';
      img.title = 'Click to enlarge';
      img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openImageLightbox(img.currentSrc || img.src || webviewUri || localPath, name || 'artifact');
      });
      node.appendChild(img);
      const showImageError = () => {
        if (id) {
          rpc('artifact.readAsDataUri', { chatId, id, agentId: payloadAgentId || undefined }).then(r => {
            if (r && r.dataUri) img.src = r.dataUri;
            else img.classList.add('err');
          }).catch(() => img.classList.add('err'));
        } else if (localPath && img.src !== localPath) {
          rpc('file.readAsDataUri', { path: localPath }).then(r => {
            if (r && r.dataUri) img.src = r.dataUri;
            else img.classList.add('err');
          }).catch(() => img.classList.add('err'));
        } else {
          img.classList.add('err');
        }
      };
      img.addEventListener('error', showImageError, { once: true });
      if (localPath) {
        const pathEl = document.createElement('div');
        pathEl.className = 'art-image-path';
        pathEl.textContent = localPath;
        pathEl.title = localPath;
        node.appendChild(pathEl);
      }
    } else {
      // File card: filename + storage path + size + Preview/Save As.
      node = document.createElement('div');
      node.className = 'art-file';
      node.dataset.artifactId = id;

      const icon = document.createElement('div');
      icon.className = 'art-file-icon';
      icon.textContent = artFileIcon(name || '');

      const meta = document.createElement('div');
      meta.className = 'art-file-meta';
      const nameEl = document.createElement('div');
      nameEl.className = 'art-file-name';
      nameEl.textContent = name || id;
      const pathEl = document.createElement('div');
      pathEl.className = 'art-file-path';
      pathEl.textContent = localPath || '';
      pathEl.title = localPath || '';
      const sizeEl = document.createElement('div');
      sizeEl.className = 'art-file-size';
      sizeEl.textContent = [artFmtBytes(Number(size || 0)), artFmtTime(payload.savedAt)].filter(Boolean).join(' · ');
      meta.appendChild(nameEl);
      meta.appendChild(pathEl);
      meta.appendChild(sizeEl);

      const actions = document.createElement('div');
      actions.className = 'art-file-actions';
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'btn';
      preview.textContent = 'Preview';
      preview.addEventListener('click', async () => {
        preview.disabled = true;
        const prevLabel = preview.textContent;
        preview.textContent = 'Loading…';
        try {
          const r = id ? await rpc('artifact.preview', { chatId, id, agentId: payloadAgentId || undefined }) : await rpc('file.preview', { path: localPath || '' });
          if (!r || r.error) throw new Error((r && r.error) || 'preview failed');
          const artId = addArtifact({
            kind:      r.kind || 'text',
            title:     name || id,
            source:    r.source || r.html || r.text || '',
            path:      localPath || '',
            data:      r.data,
            text:      r.text,
            lang:      r.lang,
            delimiter: r.delimiter,
            filename:  r.filename,
            artifactId: id,
            chatId,
            mediaType: mt,
            live: payload.live,
            version: payload.version,
            updatedAt: payload.updatedAt,
          });
          try { selectArtifact(artId); openArtifactPanel(); } catch {}
        } catch (e) {
          console.warn('[studio] artifact preview failed:', e);
          showToast('Preview failed: ' + (e && e.message || e), 'error', 5000);
        } finally {
          preview.disabled = false;
          preview.textContent = prevLabel;
        }
      });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'btn';
      save.textContent = 'Save As';
      save.addEventListener('click', () => saveAsDownload({ id, chatId, agentId: payloadAgentId || undefined, path: localPath || '' }));
      actions.appendChild(preview);
      actions.appendChild(save);

      node.appendChild(icon);
      node.appendChild(meta);
      node.appendChild(actions);
    }

    if (toolUseId) node.dataset.toolUseId = String(toolUseId);
    node.dataset.artifactKey = logicalKey;
    node.dataset.mediaType = mt;
    node.dataset.artifactSize = String(Number(size || 0));
    if (payload.live) {
      node.classList.add('is-live');
      const badge = document.createElement('span');
      badge.className = 'art-live-badge';
      badge.textContent = 'live';
      node.appendChild(badge);
      ensureLiveArtifactPolling({ ...payload, chatId, id });
    }

    const existingInBody = body.querySelector(
      toolUseId
        ? `:scope > [data-artifact-id="${cssEscape(String(id))}"][data-tool-use-id="${cssEscape(String(toolUseId))}"]`
        : `:scope > [data-artifact-key="${cssEscape(logicalKey)}"][data-artifact-id="${cssEscape(String(id))}"]`
    );
    if (existingInBody) {
      refreshArtifactCard(payload, false);
      return;
    }

    if (insertAfter && insertAfter.parentNode === body) {
      body.insertBefore(node, insertAfter.nextSibling);
    } else if (isExcalidrawSnapshot) {
      const mem = Array.from(body.children).find(el => el.classList && el.classList.contains('msg-memory-card'));
      if (mem) body.insertBefore(node, mem);
      else body.appendChild(node);
    } else {
      body.appendChild(node);
    }
    dbg(`onArtifactAttach INSERTED id=${id} mt=${mt} nodeClass=${node.className} hasFrame=${!!node.querySelector && !!node.querySelector('iframe')} inDom=${node.isConnected}`);
  }

  function artFmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const units = ['B','KB','MB','GB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function artFmtTime(ts) {
    const n = Number(ts || 0);
    if (!n) return '';
    const ms = n < 10_000_000_000 ? n * 1000 : n;
    try {
      return new Date(ms).toLocaleString([], {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return ''; }
  }

  function artFileIcon(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (['doc','docx'].includes(ext))   return '📄';
    if (['xls','xlsx','csv'].includes(ext)) return '📊';
    if (['ppt','pptx'].includes(ext))   return '📽';
    if (ext === 'pdf')                  return '📕';
    if (['zip','tar','gz'].includes(ext)) return '🗜';
    if (['json','xml','html','md','txt','log'].includes(ext)) return '📝';
    return '📎';
  }

  /** Host broadcast — sandbox produced a non-image file (.docx, .xlsx,
   *  .pdf, .csv, .zip, …). Render a card with filename + size + actions
   *  (Open / Save). Image media types fall through to onImageAttach so
   *  this handler doesn't double-render. */
  function onFileAttach(payload, _retry = 0) {
    const { chatId, filename, size, url, mediaType, localPath, webviewUri, toolUseId } = payload || {};
    if (payload?.artifactId || payload?.id || payload?.pinned || payload?.isAuraArtifact) return;
    // 0.4.93 — trace docx/non-image path since images survive but files
    // don't on reload. Logs go to webview console (DevTools) — user pings
    // them so we can see exactly which drop condition fires.
    if (_retry === 0 && filename && !(mediaType||'').startsWith('image/')) {
      console.log('[studio] onFileAttach recv', {filename, mediaType, tid: toolUseId, active: state.activeChatId, chat: chatId});
    }
    if (!chatId || chatId !== state.activeChatId) return;
    if (!filename) return;
    if (!url && !localPath) return;
    // Sandbox-produced files should not render inline by themselves. If the
    // assistant pins one with aura_artifact_pin, artifact.attach/aura_artifact
    // renders it after the pin tool result instead.
    return;
    // 0.4.90 — mirror onImageAttach retry semantics: if a toolUseId was
    // provided but the anchor block hasn't rendered yet, requestAnimationFrame
    // retry for up to ~500ms. 0.4.92 changed replay to be triggered from
    // the webview post-render so anchors are almost always present now,
    // but the retry stays as a belt for late tool_use rendering.
    if (toolUseId) {
      const anchorTU = els.threadInner.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
      );
      if (!anchorTU) {
        if (_retry < 30) {
          requestAnimationFrame(() => onFileAttach(payload, _retry + 1));
          return;
        }
      }
    }
    // (guards moved above the retry so they run once, not on every rAF)
    // 0.4.87 — dedup scoped to the SAME assistant bubble via toolUseId.
    // A regenerate that produces same filename in a DIFFERENT turn is
    // still a legit second card. Cross-bubble dedup was too aggressive:
    // it silently ate the fresh card and the bubble looked "thinking-only".
    const dedupKey = (localPath || filename) + '::' + (toolUseId || '');
    if (toolUseId) {
      const anchorTU = els.threadInner.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
      );
      const bubble = anchorTU ? anchorTU.closest('.msg-assistant') : null;
      if (bubble) {
        const existing = bubble.querySelector(
          `.msg-file-card[data-dedup-key="${cssEscape(dedupKey)}"]`
        );
        if (existing) return;
      }
    }
    if (typeof mediaType === 'string' && mediaType.startsWith('image/')) {
      // Defer to image card so we don't render twice. Prefer the host's
      // pre-escaped webviewUri (vscode-resource://) — falling back to the
      // raw HTTP url breaks under the webview CSP `img-src` policy.
      return onImageAttach({
        chatId,
        webviewUri: webviewUri || url,
        localPath,
        filename, mediaType, source: filename,
        toolUseId,
      });
    }
    // 0.4.25 — same anchoring logic as onImageAttach.
    let anchorTool = null;
    if (toolUseId) {
      anchorTool = els.threadInner.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(toolUseId))}"]`
      );
    }
    const a = state.pendingAsstByChat?.get?.(chatId);
    let insertAfter = anchorTool ? (anchorTool.closest('[data-blk-idx]') || anchorTool.closest('.tool-card') || anchorTool) : null;
    let body = insertAfter ? insertAfter.parentNode : null;
    if (body) {
      const escaped = escapeToolContainer(insertAfter, body);
      insertAfter = escaped.insertAfter;
      body = escaped.body;
    }
    if (!body) body = a?.body || null;
    if (!body) {
      const sel = `.msg-assistant[data-chat-id="${cssEscape(chatId)}"]`;
      const bubbles = els.threadInner.querySelectorAll(sel);
      const target = bubbles[bubbles.length - 1];
      if (!target) return;
      body = target.querySelector('.msg-body') || target;
    }

    const card = document.createElement('div');
    card.className = 'msg-file-card';
    card.title = filename;
    // 0.4.87 — dedup key: (path or filename) + toolUseId. Scoped to the
    // owning tool call so a regenerate in a different turn still renders.
    card.dataset.dedupKey = (localPath || filename) + '::' + (toolUseId || '');

    const icon = document.createElement('span');
    icon.className = 'mfc-ico';
    icon.textContent = pickFileIcon(filename, mediaType);

    const meta = document.createElement('div');
    meta.className = 'mfc-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'mfc-name';
    nameEl.textContent = filename;
    const sizeEl = document.createElement('div');
    sizeEl.className = 'mfc-sub muted small';
    sizeEl.textContent = formatBytes(size) + ' · ' + prettyFileType(filename, mediaType);
    meta.appendChild(nameEl);
    meta.appendChild(sizeEl);
    // v0.4.257 — show host storage path so user knows where the file lives.
    if (localPath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'mfc-sub muted small mfc-path';
      pathEl.textContent = localPath;
      pathEl.title = localPath;
      meta.appendChild(pathEl);
    }

    const actions = document.createElement('div');
    actions.className = 'mfc-actions';
    // #8 in 0.2.18 — replaced "Open" (which was target=_blank, the webview
    // intercepts as a download in VS Code) with "Preview" that opens the
    // file inside the artifact panel iframe. PDFs / text / html render
    // inline; for office types we ask the host to convert to HTML first.
    const preview = document.createElement('button');
    preview.className = 'ghost-btn';
    preview.textContent = 'Preview';
    preview.onclick = async () => {
      const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
      if ((localPath || url) && PREVIEWABLE_EXT.has(ext)) {
        preview.disabled = true;
        preview.textContent = 'Loading…';
        try {
          const r = await rpc('file.preview', { path: localPath || filename, url });
          if (r?.error) throw new Error(r.error);
          const artId = addArtifact({
            kind: r.kind || 'text',
            title: filename,
            source: r.source || r.html || r.text || '',
            path: localPath || filename,
            data: r.data, text: r.text, lang: r.lang, delimiter: r.delimiter, filename: r.filename,
          });
          try { selectArtifact(artId); openArtifactPanel(); } catch {}
          return;
        } catch (e) {
          console.warn('[studio] file preview failed:', e);
          showToast('Preview failed: ' + (e && e.message || e), 'error', 5000);
        } finally {
          preview.disabled = false;
          preview.textContent = 'Preview';
        }
      }
      previewSandboxFile(url, filename, mediaType);
    };
    // 0.4.87 — after reload the sandbox HTTP url is dead, but localPath
    // (the host-cached copy) still exists. Prefer localPath through the
    // file.saveAs RPC (which opens a native save dialog). Fall back to
    // the sandbox url for fresh in-turn broadcasts where it's still live.
    let dl;
    if (localPath) {
      dl = document.createElement('button');
      dl.className = 'primary-btn';
      dl.textContent = 'Download';
      dl.onclick = async () => {
        dl.disabled = true;
        try { await saveAsDownload({ path: localPath }); }
        finally { dl.disabled = false; }
      };
    } else {
      dl = document.createElement('a');
      dl.href = url;
      dl.download = filename;
      dl.className = 'primary-btn';
      dl.textContent = 'Download';
    }
    actions.appendChild(preview);
    actions.appendChild(dl);

    card.appendChild(icon);
    card.appendChild(meta);
    card.appendChild(actions);
    if (insertAfter && insertAfter.parentNode === body) {
      let after = insertAfter;
      const matchesResult = (el) => {
        if (!el || !el.querySelector) return false;
        const sel = `.blk-tool-result[data-tool-use-id="${cssEscape(String(toolUseId))}"]`;
        return el.matches?.(sel) || !!el.querySelector(sel);
      };
      const isEmptyStrip = (el) => el && el.classList && el.classList.contains('msg-artifact-strip') && !el.firstChild;
      while (after.nextSibling && (matchesResult(after.nextSibling) || isEmptyStrip(after.nextSibling))) after = after.nextSibling;
      body.insertBefore(card, after.nextSibling);
    } else {
      // 0.4.131 — no anchor: append directly to body. See onImageAttach.
      body.appendChild(card);
    }

    if (chatId === state.activeChatId && typeof scrollThreadToEnd === 'function') {
      scrollThreadToEnd();
    }
  }

  function pickFileIcon(name, mediaType) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (mediaType?.startsWith('image/')) return '🖼';
    if (mediaType === 'application/pdf') return '📕';
    if (ext === 'docx' || ext === 'doc') return '📘';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return '📗';
    if (ext === 'pptx' || ext === 'ppt') return '📙';
    if (ext === 'zip' || ext === 'tar' || ext === 'gz') return '🗜';
    if (ext === 'json' || ext === 'yaml' || ext === 'yml' || ext === 'xml') return '🗂';
    if (ext === 'html') return '🌐';
    if (ext === 'md' || ext === 'txt') return '📝';
    return '📄';
  }

  function formatBytes(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '';
    if (n < 1024)              return n + ' B';
    if (n < 1024 * 1024)       return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  /** 0.4.148 — map raw mimetype/filename to a short, human label for the
   *  file-card subtitle. Previously the subtitle showed the verbose
   *  application/vnd.openxmlformats-officedocument.wordprocessingml.document
   *  string, which wrapped onto two lines and looked unprofessional
   *  (screenshot #65). Falls back to a generic label if we don't recognise it. */
  function prettyFileType(name, mediaType) {
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    const byExt = {
      docx: 'Word', doc: 'Word',
      xlsx: 'Excel', xls: 'Excel', csv: 'CSV', tsv: 'TSV',
      pptx: 'PowerPoint', ppt: 'PowerPoint',
      pdf: 'PDF',
      md: 'Markdown', txt: 'Text', rtf: 'RTF',
      json: 'JSON', xml: 'XML', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI',
      html: 'HTML', htm: 'HTML', svg: 'SVG',
      zip: 'ZIP', tar: 'TAR', gz: 'GZip', '7z': '7-Zip',
      py: 'Python', js: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
      c: 'C', cpp: 'C++', h: 'C header', hpp: 'C++ header',
      go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
      sh: 'Shell', bash: 'Shell', log: 'Log',
      epub: 'EPUB',
    };
    if (byExt[ext]) return byExt[ext];
    if (mediaType) {
      if (mediaType.startsWith('image/')) return mediaType.slice(6).toUpperCase();
      if (mediaType.startsWith('audio/')) return mediaType.slice(6).toUpperCase();
      if (mediaType.startsWith('video/')) return mediaType.slice(6).toUpperCase();
      if (mediaType.startsWith('text/'))  return 'Text';
    }
    return ext ? ext.toUpperCase() : 'File';
  }

  /** Host broadcasts {chatId, streaming:true|false} when a chat enters or
   *  leaves the streaming state. We track this in state.streamingChats so
   *  the composer Send/Stop button can reflect the ACTIVE chat's state. */
  function onChatStreaming({ chatId, streaming }) {
    if (streaming) state.streamingChats.add(chatId);
    else state.streamingChats.delete(chatId);
    if (chatId === state.activeChatId) refreshComposerButtons();
  }

  /** 0.4.189 — MinerU parse progress. Backend fires this at
   *  queued → parsing (with optional percent) → done | error, keyed by
   *  the attachment `hash`. The chip stays `.parsing` until `done`; we
   *  update its label so the user can see the pipeline is alive when the
   *  parse takes 30-60s on big PDFs. On `error`, add `.error` so v0.4.185's
   *  send-guard stops fighting the chip. Optimistic-side chip (before RPC
   *  returns hash) uses a tmp id, so we can't match this event until the
   *  chip has finalized; that's fine — the RPC's post-success replaceWith
   *  swaps in a chip with data-hash and the next state event lands. */
  function onAttachProgress(payload) {
    if (!payload) return;
    const { chatId, hash, state: st, percent, error, label } = payload;
    if (chatId && chatId !== state.activeChatId) return;
    const strip = $('#attachStrip');
    if (!strip || !hash) return;
    // 0.4.195 — the optimistic chip carries a tmp id (tmp-xxx) until the
    // attach.add RPC returns with the real hash. Progress events fire
    // BEFORE that return, so a strict data-hash lookup would silently
    // drop every intermediate stage label and only the eventual chip
    // replaceWith(finalChip) would signal completion — which is what
    // the user saw in Image #54 (spinner only, no stage text).
    // Fallback: any still-parsing chip that has not yet been finalized
    // with a real hash — there's at most one such chip mid-flight per
    // upload.
    let chip = strip.querySelector(`.attach-chip[data-hash="${hash}"]`);
    if (!chip) {
      chip = strip.querySelector('.attach-chip.parsing[data-hash^="tmp-"]');
    }
    if (!chip) return;
    const labelEl = chip.querySelector('.label');
    if (!labelEl) return;
    if (st === 'parsing' || st === 'queued') {
      // 0.4.195 — backend now labels each stage (Staging → MinerU@host →
      // Writing cache); the chip surfaces the current one so the user can
      // tell WHERE a slow attach is stuck.
      const pctStr = (typeof percent === 'number' && isFinite(percent)) ? ` ${Math.round(percent)}%` : '';
      const original = labelEl.dataset.origText || labelEl.textContent || '';
      labelEl.dataset.origText = original;
      const stageText = label || (st === 'queued' ? 'Queued…' : 'Parsing…');
      labelEl.textContent = `${stageText}${pctStr} — ${original}`;
    } else if (st === 'done') {
      // 0.4.190 — MinerU finished before the RPC's replaceWith(finalChip)
      // paint step. Drop `.parsing` NOW so a keystroke Send that lands in
      // the gap between broadcast and replace doesn't see the chip as
      // still-parsing (Image #43: user pressed Enter, got "Waiting for
      // 1 attachment" hint even though the file had already parsed).
      chip.classList.remove('parsing');
    } else if (st === 'error') {
      chip.classList.add('error');
      chip.classList.remove('parsing');
      const original = labelEl.dataset.origText || labelEl.textContent || '';
      labelEl.textContent = `${original} — ${error || 'parse failed'}`;
    }
    // 'queued' handled implicitly: only sets the initial chip state.
  }

  /** Host tells us the persisted turn-id of the user message we just sent.
   *  Tag the optimistic bubble so appendMissingTurns() won't duplicate it. */
  function onUserTurnId({ chatId, turnId, synthetic }) {
    if (chatId !== state.activeChatId) return;
    // Browser-mode sends can originate from another client, so this webview may
    // not have an optimistic user bubble to tag. Hydrate the persisted user turn
    // before assistant streaming continues so the visual order stays correct.
    let tagged = false;
    // v0.2.18 — synthetic resume turns (outer-loop "(continue)") should NOT
    // render as a visible user bubble. Discard any leftover optimistic bubble
    // from the previous send (defensive — there usually isn't one for outer-
    // loop iterations) and bail before we tag anything.
    if (synthetic) {
      const stale = els.threadInner.querySelectorAll('.msg-user[data-optimistic="1"]');
      for (const b of stale) {
        if (!b.dataset.turnId) b.remove();
      }
      return;
    }
    // Walk user bubbles oldest-first and grab the first marked optimistic.
    // Avoid :not(...) selector for jsdom compatibility.
    const bubbles = els.threadInner.querySelectorAll('.msg-user[data-optimistic="1"]');
    for (const b of bubbles) {
      if (!b.dataset.turnId) {
        b.dataset.turnId = String(turnId);
        delete b.dataset.optimistic;
        tagged = true;
        break;
      }
    }
    if (!tagged && turnId !== undefined && turnId !== null) {
      appendMissingTurns().catch(e => console.warn('[studio] appendMissingTurns userTurn:', e));
    }
  }

  /** 0.4.27 — each inner-loop iteration is a separate assistant turn.
   *  When the backend opens iter ≥ 2 (e.g. response text after a tool
   *  loop), close the previous streaming bubble and start a fresh one
   *  so its block-index map doesn't collide with the prior iter's blocks
   *  (which would otherwise leave stale tool_use blocks and duplicate
   *  prose in the same bubble). */
  function onAsstStart({ chatId }) {
    const prev = state.pendingAsstByChat.get(chatId);
    if (!prev) return;   // nothing in flight → onChatStart will create the first bubble
    // 0.4.44 — backend fires `assistant-start` for EVERY inner iter,
    // including the very first one right after onChatStart created the
    // bubble. If we always spawn a new bubble we end up with two empty
    // "Thinking…" bubbles stacked. Only fork into a new bubble when the
    // current one already has real block content (text/thinking/tool_use
    // delta has landed).
    if (!prev.blocks || prev.blocks.size === 0) return;
    // Mark the previous bubble settled. It still carries data-turn-id from
    // onAsstTurnId fired by `asst-persisted`, so appendMissingTurns won't
    // duplicate it.
    prev.wrap.classList.remove('streaming');
    // 0.4.173 — the streaming status banner ("Thinking…"/"Writing response…")
    // has its own pulsing dot (msg-status-dot / status-pulse) that does NOT
    // depend on .streaming, so removing that class alone leaves the dot
    // blinking forever on the settled bubble. Kill the status element so the
    // prior segment stops looking active when the next segment opens.
    if (prev.statusEl) prev.statusEl.remove();
    // 0.4.173 — segment N-1 may have ended mid-fence (truncated SVG etc.).
    // Its live "Rendering SVG…" spinner is a placeholder that will never
    // resolve now that segment N is streaming into a new bubble. Replace
    // it with the standard truncation card so the reader sees the segment
    // was cut off, not that it's "still rendering".
    prev.body?.querySelectorAll('.md-streaming-fence').forEach(el => {
      const replacement = document.createElement('div');
      replacement.className = 'md-trunc-fence';
      replacement.innerHTML =
        '<span>⚠ Segment ended before this block closed. Continuation resumes below.</span>';
      el.replaceWith(replacement);
    });
    // Create a brand-new bubble for the upcoming iter.
    const wrap = document.createElement('div');
    // 0.4.161 — if backend is inside a continuation loop, tag the new
    // bubble as a continuation part. CSS then removes the top border /
    // margin / gutter so the segments visually appear as one flowing
    // bubble even though each segment is a distinct DOM node with
    // isolated content_block indices.
    const isContinuation = state.continuationActive.has(chatId);
    wrap.className = isContinuation
      ? 'msg msg-assistant streaming continuation-part'
      : 'msg msg-assistant streaming';
    wrap.dataset.chatId = chatId;
    const body = document.createElement('div');
    body.className = 'msg-body';
    const statusEl = document.createElement('div');
    statusEl.className = 'msg-status';
    const nextLabel = isContinuation ? 'Continuing…' : 'Continuing after tool…';
    statusEl.innerHTML = `<span class="msg-status-dot"></span><span class="msg-status-label">${nextLabel}</span>`;
    body.appendChild(statusEl);
    wrap.appendChild(body);
    if (chatId === state.activeChatId) {
      els.threadInner.appendChild(wrap);
      scrollThreadToEnd(true);
    }
    state.pendingAsstByChat.set(chatId, {
      chatId, wrap, body, statusEl,
      blocks: new Map(),
      toolBuf: new Map(),
      flushPending: false,
    });
  }

  /** v0.2.18 — host signals outer-loop hit cap without [DONE].
   *  Show a banner so the user knows to click ▶ Continue (the per-turn
   *  resume button is rendered separately by onChatDone in Dev Mode). */
  function onOuterCapReached({ chatId, cap }) {
    if (chatId !== state.activeChatId) return;
    if (els.threadInner.querySelector('.outer-cap-banner')) return;  // dedupe
    const banner = document.createElement('div');
    banner.className = 'outer-cap-banner';
    banner.textContent = `⚠️ Developer outer loop cap reached (${cap || 30}) without [DONE] marker. Click ▶ Continue to resume.`;
    els.threadInner.appendChild(banner);
  }

  /** Host tells us the persisted turn-id of the assistant message just emitted
   *  (per tool-loop iter). Without this tag, the next tool.done's
   *  appendMissingTurns() pulls the persisted asst turn from DB and renders it
   *  as a NEW bubble — duplicating prose + thinking. Tag the in-flight wrap
   *  for THIS chat so appendMissingTurns()'s `data-turn-id` filter skips it. */
  function onAsstTurnId({ chatId, turnId }) {
    const a = state.pendingAsstByChat.get(chatId);
    if (!a?.wrap) return;
    // The streaming wrap may not be in DOM yet for non-active chats — that's
    // fine, we still tag it so when the user switches back appendMissingTurns
    // recognizes it. Idempotent: only set if missing.
    if (!a.wrap.dataset.turnId) a.wrap.dataset.turnId = String(turnId);
  }

  /** Host asked us to run a `python_browser` tool call in Pyodide. We open
   *  an artifact tab, run the code in a hidden worker iframe, and post the
   *  captured stdout/stderr + figure count back via vscode.postMessage. */
  function onPyodideRun({ toolUseId, code }) {
    // Show an artifact tab right away so the user sees execution progress.
    if (typeof addArtifact === 'function') {
      addArtifact({ kind: 'pyodide', title: `python_browser`, source: code });
    }
    // Run in a hidden iframe — same Pyodide srcdoc as the artifact preview
    // but with a postMessage hook so we can collect stdout/stderr.
    const sandbox = document.createElement('iframe');
    sandbox.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;';
    sandbox.sandbox = 'allow-scripts';
    document.body.appendChild(sandbox);
    let stdout = '', stderr = '', figures = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sandbox.remove(); } catch {}
      vscode.postMessage({
        type: 'pyodide.result',
        payload: { toolUseId, stdout, stderr, figures },
      });
    };
    const onMsg = (e) => {
      if (!e.data || e.data._aura !== 'pyodide-tool' || e.data.toolUseId !== toolUseId) return;
      if (e.data.event === 'stdout') stdout += e.data.text;
      else if (e.data.event === 'stderr') stderr += e.data.text;
      else if (e.data.event === 'figure') figures += 1;
      else if (e.data.event === 'done') {
        window.removeEventListener('message', onMsg);
        finish();
      } else if (e.data.event === 'error') {
        stderr += e.data.text || 'unknown error';
        window.removeEventListener('message', onMsg);
        finish();
      }
    };
    window.addEventListener('message', onMsg);
    sandbox.srcdoc = pyodideToolSrcdoc(code, toolUseId);
    // Hard timeout — match host's 90s.
    setTimeout(() => {
      if (!settled) {
        stderr += '\n[python_browser] timed out after 90s';
        window.removeEventListener('message', onMsg);
        finish();
      }
    }, 90_000);
  }

  /** Pyodide srcdoc for the `python_browser` tool: minimal HTML, runs the
   *  user's code, and pipes stdout/stderr/figure counts back to parent. */
  function pyodideToolSrcdoc(code, toolUseId) {
    const safeCode = JSON.stringify(code);
    const safeId   = JSON.stringify(toolUseId);
    return `<!DOCTYPE html><html><body>
    <script type="module">
    const code = ${safeCode};
    const id = ${safeId};
    const post = (event, text) => parent.postMessage({ _aura:'pyodide-tool', toolUseId:id, event, text }, '*');
    try {
      const { loadPyodide } = await import('https://cdn.jsdelivr.net/pyodide/v0.26.0/full/pyodide.mjs');
      const pyo = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/' });
      pyo.setStdout({ batched: (s) => post('stdout', s) });
      pyo.setStderr({ batched: (s) => post('stderr', s) });
      try {
        await pyo.loadPackagesFromImports(code).catch(() => {});
        await pyo.runPythonAsync(code);
      } catch (e) {
        post('stderr', String(e));
      }
      try {
        const n = pyo.runPython('len(__import__("matplotlib.pyplot").pyplot.get_fignums()) if "matplotlib" in __import__("sys").modules else 0');
        for (let i = 0; i < (n||0); i++) post('figure', '');
      } catch {}
      post('done', '');
    } catch (e) {
      post('error', String(e));
    }
    <\/script></body></html>`;
  }

  /* ── Theme ──────────────────────────────────────────────────────── */
  // v0.4.0 — single dark theme. The legacy theme names still flow in
  // from persisted settings; we ignore the requested name and always
  // set theme-aura-dark, which themes.css aliases the old class names
  // to anyway. Keeps the persistence path working without a migration.
  function setTheme(_name) {
    state.theme = 'aura-dark';
    els.body.className = els.body.className.replace(/theme-\w+/g, '').trim();
    els.body.classList.add('theme-aura-dark');
    // Old picker tiles, if present in the DOM, are forced inactive.
    document.querySelectorAll('.theme-tile').forEach(tile => {
      tile.classList.remove('active');
      const r = tile.querySelector('input[type=radio]');
      if (r) r.checked = false;
    });
  }

  /* ── Refreshers ─────────────────────────────────────────────────── */
  async function refreshModelPicker() {
    // 0.4.197 — model list comes from host.yaml ui_models. Populate
    // #modelPicker <option>s here so a YAML edit is the only place needed
    // to add a new model.
    if (!els.modelPicker) return;
    let res;
    try { res = await rpc('config.uiModels'); }
    catch (e) { console.warn('[studio] config.uiModels rpc failed:', e); return; }
    const list = Array.isArray(res?.models) ? res.models : [];
    state.unavailableModels = new Set(Array.isArray(res?.unavailableModels) ? res.unavailableModels.map(String) : []);
    if (!list.length) return;  // keep the hardcoded fallback if backend has nothing
    const prev = els.modelPicker.value;
    els.modelPicker.innerHTML = '';
    let defaultId = '';
    for (const m of list) {
      const opt = document.createElement('option');
      opt.value = m.id;
      const locked = state.unavailableModels.has(String(m.id));
      opt.textContent = `${m.label || m.id}${locked ? ' — unavailable' : ''}`;
      opt.className = locked ? 'model-unavailable-option' : '';
      opt.title = locked ? 'Temporarily unavailable for sub-agents' : '';
      if (typeof m.context === 'number') opt.dataset.context = String(m.context);
      if (typeof m.maxOutput === 'number') opt.dataset.maxOutput = String(m.maxOutput);
      if (m.family) opt.dataset.family = m.family;
      els.modelPicker.appendChild(opt);
      if (m.default) defaultId = m.id;
    }
    // Preserve prior selection if still valid; else fall back to yaml
    // default; else first entry.
    const ids = list.map(m => m.id);
    const prevModel = list.find(m => m.id === prev);
    // Don't restore a deprecated model — fall through to default.
    if (prev && ids.includes(prev) && !prevModel?.deprecated) els.modelPicker.value = prev;
    else if (defaultId) els.modelPicker.value = defaultId;
    else els.modelPicker.value = list[0].id;
    updateModelUnavailableButton();
  }

  /* Reflect the proxy's active upstream provider in the Settings panel, and —
     when a custom provider is active — swap the model picker to its model list. */
  function applyProviderState(p) {
    if (!p) return;
    const mode = p.mode || 'default';
    const dot = $('#hostProviderDot'); if (dot) dot.className = 'host-dot ' + (mode === 'default' ? 'on' : 'warn');
    const lbl = $('#hostProviderLabel');
    if (lbl) lbl.textContent = mode === 'default'
      ? 'Upstream: not connected'
      : `Upstream: ${mode} @ ${p.base_url || ''}`;
    if (mode !== 'default' && Array.isArray(p.models) && p.models.length) applyProviderModels(p.models);
  }

  /* Replace the model picker with a custom provider's model ids (label = id). */
  function applyProviderModels(models) {
    if (!els.modelPicker || !Array.isArray(models) || !models.length) return;
    const prev = els.modelPicker.value;
    els.modelPicker.innerHTML = '';
    for (const id of models) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      els.modelPicker.appendChild(opt);
    }
    els.modelPicker.value = models.includes(prev) ? prev : models[0];
    state.unavailableModels = new Set();
    updateModelUnavailableButton();
  }
  function updateModelUnavailableButton() {
    if (!els.modelUnavailableBtn || !els.modelPicker) return;
    const id = els.modelPicker.value;
    const locked = state.unavailableModels.has(id);
    els.modelUnavailableBtn.textContent = locked ? '●' : '○';
    els.modelUnavailableBtn.classList.toggle('is-locked', locked);
    els.modelUnavailableBtn.title = locked
      ? `${id} is temporarily unavailable for sub-agents. Click to allow it again.`
      : `Mark ${id} temporarily unavailable for sub-agents.`;
    els.modelPicker.classList.toggle('model-unavailable-selected', locked);
  }
  async function toggleSelectedModelUnavailable() {
    if (!els.modelPicker) return;
    const id = els.modelPicker.value;
    const unavailable = !state.unavailableModels.has(id);
    const res = await rpc('config.setModelUnavailable', { id, unavailable });
    state.unavailableModels = new Set(Array.isArray(res?.unavailableModels) ? res.unavailableModels.map(String) : []);
    await refreshModelPicker();
  }
  async function refreshProjects() {
    state.projects = await rpc('projects.list');
    if (!state.activeProjectId && state.projects.length) state.activeProjectId = state.projects[0].id;
    renderProjects();
  }
  async function refreshRecentChats() {
    state.chats = await rpc('chats.recent', { limit: 50 });
    renderRecent();
    refreshProjectLabel();
  }
  /** Sort state.chats in place by current dropdown selection. */
  function applyRecentSort() {
    const sel = document.getElementById('recentSort');
    const mode = sel ? sel.value : 'updated';
    const arr = state.chats.slice();
    if (mode === 'updated')      arr.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    else if (mode === 'created') arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    else if (mode === 'title')   arr.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    state.chats = arr;
  }
  function onInvalidate(scope, payload) {
    if (scope === 'projects') refreshProjects();
    if (scope === 'chats') {
      refreshChatLists().catch(e => console.warn('[studio] chat list refresh failed:', e));
    }
    if (scope === 'activeChat' && state.activeChatId) {
      appendMissingTurns().catch(e => console.warn('[studio] activeChat hydrate failed:', e));
      refreshContextUsage().catch(() => {});
    }
  }

  async function refreshChatLists() {
    await Promise.all([
      refreshProjects().catch(e => console.warn('[studio] projects.list failed:', e)),
      refreshRecentChats().catch(e => console.warn('[studio] chats.recent failed:', e)),
      refreshActiveStreamingState().catch(e => console.warn('[studio] active stream refresh failed:', e)),
    ]);
    if (state.view === 'project' && state.activeProjectId) {
      rpc('chats.listByProject', { projectId: state.activeProjectId })
        .then(renderProjectChatList).catch(() => {});
    }
  }

  async function refreshActiveStreamingState() {
    const r = await rpc('chat.activeIds');
    if (!Array.isArray(r?.chatIds)) return;
    state.streamingChats = new Set(r.chatIds.map(String));
    if (r.queuedByChat && typeof r.queuedByChat === 'object') {
      for (const [chatId, text] of Object.entries(r.queuedByChat)) onChatQueued({ chatId, text });
    }
    refreshComposerButtons();
  }

  function bindCrossWindowRefresh() {
    if (state._crossWindowRefreshBound) return;
    state._crossWindowRefreshBound = true;
    let inflight = false;
    const refresh = async () => {
      if (inflight) return;
      inflight = true;
      try { await refreshChatLists(); }
      finally { inflight = false; }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
    setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
  }

  /* ── Render lists ───────────────────────────────────────────────── */
  function renderProjects() {
    // 0.4.189 — the backend prepends a virtual `__orphan__` entry so the
    // rail can render it as a first-class row alongside real projects. It
    // has no rename/delete affordances (they're refused server-side) and
    // uses a distinct icon so users can tell it apart.
    els.projectList.innerHTML = state.projects.map(p => {
      const orphan = p.id === '__orphan__' || p.isVirtual;
      const cls = ['rail-item'];
      if (p.id === state.activeProjectId) cls.push('active');
      if (orphan) cls.push('orphan');
      const icon = orphan ? `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 6h4l1.2-1.5h7.8l-1.6 8.1A1.5 1.5 0 0 1 11.4 14H2.8a1.2 1.2 0 0 1-1.2-1.2L1.5 6z"/><path d="M1.5 6V3.4A1.4 1.4 0 0 1 2.9 2h3l1.2 1.4h4.4A1.4 1.4 0 0 1 12.9 4v.5"/></svg>` : `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5h4l1.3 1.7h7.7v6.6a1.2 1.2 0 0 1-1.2 1.2H2.7a1.2 1.2 0 0 1-1.2-1.2V4.5z"/><path d="M1.5 4.5V3.2A1.2 1.2 0 0 1 2.7 2h3.1l1.3 1.5h6.2a1.2 1.2 0 0 1 1.2 1.2v1.5"/></svg>`;
      const actions = orphan
        ? `<span class="rail-actions" title="System project — holds chats without a parent. Delete individual chats to remove them."></span>`
        : `<span class="rail-actions">
             <button class="rail-x" data-act="renameProject" data-id="${p.id}" title="Rename project">✎</button>
             <button class="rail-x" data-act="deleteProject" data-id="${p.id}" title="Delete project">✕</button>
           </span>`;
      return `
        <li class="${cls.join(' ')}"
            data-act="selectProject" data-id="${p.id}">
          <span class="ico">${icon}</span>
          <span class="rail-title">${escapeHtml(p.name)}</span>
          ${actions}
        </li>`;
    }).join('');
    refreshProjectLabel();
  }
  /** 0.4.177 — replaced the editable project picker with a read-only info
   *  label. A chat's project is decided at creation time (via New Chat →
   *  Orphan, or from a project's chat list → that project) and cannot be
   *  re-assigned in the UI. Prevents the "chat saved to wrong project" bug
   *  from selector drift. */
  function refreshProjectLabel() {
    if (!els.projectLabel) return;
    const chat = state.chats.find(c => c.id === state.activeChatId);
    const projectId = chat?.projectId || '';
    if (!projectId) { els.projectLabel.textContent = 'Orphan'; return; }
    const proj = state.projects.find(p => p.id === projectId);
    els.projectLabel.textContent = proj?.name || 'Orphan';
  }
  function renderRecent() {
    applyRecentSort();
    const sel = state.recentSelectMode;
    if (sel) {
      // Select mode: render checkboxes, suppress per-row delete (use bulk bar).
      els.recentList.innerHTML = state.chats.length
        ? state.chats.map(c => `
          <li class="rail-item rail-select ${state.recentSelectedIds.has(c.id) ? 'is-selected' : ''}"
              data-act="toggleSelect" data-id="${c.id}" title="${escapeAttr(c.title)}">
            <input type="checkbox" class="rail-check" ${state.recentSelectedIds.has(c.id) ? 'checked' : ''} />
            <span class="ico"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3l3-3h7a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/></svg></span><span class="rail-title">${escapeHtml(c.title)}</span>
          </li>`).join('')
        : `<li class="rail-item muted">No chats yet</li>`;
    } else {
      els.recentList.innerHTML = state.chats.length
        ? state.chats.map(c => `
          <li class="rail-item ${c.id === state.activeChatId ? 'active' : ''}"
              data-act="selectChat" data-id="${c.id}" title="${escapeAttr(c.title)}">
            <span class="ico"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3l3-3h7a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/></svg></span><span class="rail-title">${escapeHtml(c.title)}</span>
            <span class="rail-actions">
              <button class="rail-x" data-act="renameChat" data-id="${c.id}" title="Rename chat">✎</button>
              <button class="rail-x" data-act="deleteChat" data-id="${c.id}" title="Delete chat">✕</button>
            </span>
          </li>`).join('')
        : `<li class="rail-item muted">No chats yet</li>`;
    }
    updateRecentSelectBar();
  }

  /** Sync the bulk-delete bar visibility + count + button enablement. */
  function updateRecentSelectBar() {
    if (!els.recentSelectBar) return;
    els.recentSelectBar.hidden = !state.recentSelectMode;
    const n = state.recentSelectedIds.size;
    if (els.recentSelectCount) els.recentSelectCount.textContent = `${n} selected`;
    if (els.recentSelectDelete) els.recentSelectDelete.disabled = n === 0;
  }

  function setRecentSelectMode(on) {
    state.recentSelectMode = !!on;
    if (!on) state.recentSelectedIds.clear();
    renderRecent();
  }

  function hasChatContentInThread() {
    return !!els.threadInner?.querySelector('.msg, .msg-user, .msg-assistant');
  }

  function setEmptyChatMode(on) {
    // Empty mode deliberately floats the welcome + composer around the centre.
    // Explicit false always wins immediately, even before the optimistic first
    // user turn has rendered or attachment parsing finishes.
    if (!on) {
      els.main?.classList.remove('empty-chat');
      els.body?.classList.remove('empty-chat');
      return;
    }
    const activeStreaming = state.activeChatId && state.streamingChats.has(state.activeChatId);
    const empty = !hasChatContentInThread() && !activeStreaming;
    els.main?.classList.toggle('empty-chat', empty);
    els.body?.classList.toggle('empty-chat', empty);
  }
  function refreshEmptyChatMode() {
    const hasWelcome = !!els.threadInner.querySelector('.welcome-card');
    const hasMessages = hasChatContentInThread();
    if (hasWelcome && hasMessages) els.threadInner.querySelector('.welcome-card')?.remove();
    setEmptyChatMode(hasWelcome && !hasMessages);
  }

  /* ── Agent monitor ─────────────────────────────────────────────── */
  function agentsForActiveChat() {
    return state.agentsByChat.get(state.activeChatId) || [];
  }

  // Collapsed state persists across re-renders (keyed by agentId)
  const agentTreeCollapsed = new Set();

  function renderAgentDock() {
    const allAgents = agentsForActiveChat()
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.agentId).localeCompare(String(b.agentId)));
    if (!els.agentMonitor || !els.agentDock) return;
    els.agentMonitor.hidden = state.mainMode === 'coding' || !allAgents.length;
    if (!allAgents.length) {
      els.agentDock.innerHTML = '';
      if (els.agentDockHead) els.agentDockHead.hidden = true;
      return;
    }
    if (els.agentDockHead) els.agentDockHead.hidden = false;
    const active = allAgents.filter(a => ['queued', 'running', 'waiting'].includes(a.status)).length;
    const propagation = state.agentPropagationByChat.get(state.activeChatId);
    const phaseLabels = {
      starting: 'Preparing return…',
      summarizing: 'Summarizing…',
      ready: 'Sending to orchestrator…',
      responding: 'Orchestrator responding…',
      delivered: 'Returned ✓',
      completed: 'Returned ✓',
      failed: 'Return failed ✕',
    };
    if (els.agentDockCount) {
      els.agentDockCount.textContent = propagation?.state && phaseLabels[propagation.state]
        ? `${allAgents.length} total · ${phaseLabels[propagation.state]}`
        : `${allAgents.length} total · ${active} active`;
    }

    // Force Return All button removed from primary UI (plan §4).
    const existingForceReturnAllBtn = document.getElementById('agentForceReturnAllBtn');
    if (existingForceReturnAllBtn) existingForceReturnAllBtn.remove();

    // Header batch actions are scoped to the active/latest run only. Older
    // minimized runs remain expandable for inspection but are never included.

    // Header: "Close all" — always present, triggers destructive confirm modal
    const existingDismissBtn = document.getElementById('agentDismissAllBtn');
    if (els.agentDockHead) {
      if (!existingDismissBtn) {
        const btn = document.createElement('button');
        btn.id = 'agentDismissAllBtn';
        btn.type = 'button';
        btn.className = 'agent-dismiss-all-btn';
        btn.title = 'Delete all agent cards';
        btn.textContent = 'Close all';
        els.agentDockHead.appendChild(btn);
      } else {
        existingDismissBtn.disabled = false;
        existingDismissBtn.textContent = 'Close all';
      }
    }

    // Build tree: root agents are those with no parent in allAgents. Root runs
    // are scoped by runId so a new spawn_agents call does not mix with old roots.
    const agentById = new Map(allAgents.map(a => [a.agentId, a]));
    const childrenOf = new Map();
    const roots = [];
    for (const a of allAgents) {
      const pid = a.parentAgentId;
      if (pid && agentById.has(pid)) {
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid).push(a);
      } else {
        roots.push(a);
      }
    }
    const runOf = (a) => String(a.runId || a.agentId || '');
    const latestRoot = roots.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    const latestRunId = latestRoot ? runOf(latestRoot) : '';
    if (latestRunId && !state.activeAgentRunByChat.get(state.activeChatId)) state.activeAgentRunByChat.set(state.activeChatId, latestRunId);
    const activeRunId = state.activeAgentRunByChat.get(state.activeChatId) || latestRunId;

    const STATUS_GLYPH = {
      queued: '○', running: '●', waiting: '◎',
      completed: '✓', error: '✗', cancelled: '–', limit_reached: '⊘', released: '✓',
    };

    function renderNode(agent, prefix, isLast, lines) {
      const status = agent.status || 'queued';
      const glyph = STATUS_GLYPH[status] || '?';
      const running = ['running', 'waiting'].includes(status);
      const usagePayload = state.agentUsageById.get(agent.agentId) || {};
      const usage = usagePayload.usage || agent.usage || {};
      const cost = typeof usagePayload.costUsd === 'number' ? usagePayload.costUsd : (agent.costUsd || 0);
      const costStr = cost > 0 ? ` $${cost.toFixed(3)}` : '';
      const tokStr = (usage.inTokens || 0) > 0
        ? ` ${formatTok(usage.inTokens)}↓${formatTok(usage.outTokens)}↑` : '';
      const task = String(agent.task || agent.agentId);
      const children = childrenOf.get(agent.agentId) || [];
      const collapsed = agentTreeCollapsed.has(agent.agentId);
      const connector = prefix === '' ? '' : (isLast ? '└─ ' : '├─ ');
      const hasChildren = children.length > 0;
      const toggleGlyph = hasChildren ? (collapsed ? '▶' : '▼') : ' ';
      // Submit button: visible for all terminal agents. Summarize is per leaf.
      const isTerminal = ['completed', 'limit_reached', 'error', 'cancelled', 'released'].includes(status);
      const isActiveAgentStreaming = state.agentManualStreaming && state.activeAgentId === agent.agentId;
      const canSubmit = ['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(status) && !isActiveAgentStreaming;
      const isSubmitPending = state.agentSubmitPending.has(agent.agentId);
      const isSummarizePending = state.agentSummarizePending.has(agent.agentId);
      const canSummarize = !hasChildren && !isActiveAgentStreaming;
      const canResume = hasChildren && ['cancelled', 'error'].includes(status) && !isActiveAgentStreaming;
      // Keep forceReturn pending in state for compat but don't show the button.
      lines.push({
        agentId: agent.agentId,
        prefix,
        connector,
        toggleGlyph,
        glyph,
        task,
        status,
        running,
        tokStr,
        costStr,
        hasChildren,
        collapsed,
        isLast,
        canSubmit,
        canSummarize,
        canResume,
        isSubmitPending,
        isSummarizePending,
        autoTransferred: !!agent.autoTransferred,
        contextGuarded: !!agent.contextGuarded,
      });
      if (!collapsed && hasChildren) {
        const childPrefix = prefix + (isLast ? '   ' : '│  ');
        children.forEach((child, i) => renderNode(child, childPrefix, i === children.length - 1, lines));
      }
    }

    const lines = [];
    const activeRoots = roots.filter(root => runOf(root) === activeRunId);
    const activeRunAgents = allAgents.filter(a => runOf(a) === activeRunId);
    const hasTerminalInActiveRun = activeRunAgents.some(a => ['completed', 'limit_reached', 'error', 'cancelled', 'released'].includes(a.status));
    const activeChildParents = new Set(activeRunAgents.map(a => a.parentAgentId).filter(Boolean));
    const hasInterruptedCoordinator = activeRunAgents.some(a => activeChildParents.has(a.agentId) && ['cancelled', 'error'].includes(a.status));
    if (els.agentResumeAllBtn) {
      els.agentResumeAllBtn.hidden = !hasInterruptedCoordinator;
      els.agentResumeAllBtn.disabled = state.agentBatchRunning;
    }
    if (els.agentSummaryAllBtn) {
      els.agentSummaryAllBtn.hidden = !hasTerminalInActiveRun;
      els.agentSummaryAllBtn.disabled = state.agentBatchRunning;
    }
    if (els.agentSubmitAllBtn) {
      els.agentSubmitAllBtn.hidden = !hasTerminalInActiveRun;
      els.agentSubmitAllBtn.disabled = state.agentBatchRunning;
    }
    const oldRuns = [...new Set(roots.filter(root => runOf(root) !== activeRunId).map(runOf))];
    // Count AGENTS (not runs) in the older section — a batch spawn shares one
    // runId across several agents, so counting runs read as "9" when 10 agents
    // were shown. Count every agent whose run is not the active one.
    const oldAgentCount = allAgents.filter(a => runOf(a) !== activeRunId).length;
    activeRoots.forEach((root, i, arr) => renderNode(root, '', i === arr.length - 1, lines));
    if (!activeRoots.length) roots.forEach((root, i) => renderNode(root, '', i === roots.length - 1, lines));
    if (oldRuns.length) {
      lines.push({ runDivider: true, task: `${oldAgentCount} older agent${oldAgentCount > 1 ? 's' : ''} not included in batch actions`, status: 'released' });
      roots.filter(root => runOf(root) !== activeRunId).forEach((root, i, arr) => renderNode(root, '', i === arr.length - 1, lines));
    }

    els.agentDock.innerHTML = lines.map(row => {
      if (row.runDivider) return `<div class="agent-run-divider">${escapeHtml(row.task)}</div>`;
      const isActive = row.agentId === state.activeAgentId;
      const summarizeBtn = row.canSummarize
        ? `<span class="atr-summarize${row.isSummarizePending ? ' atr-summarize-pending' : ''}" ` +
          `data-summarize="${escapeHtml(row.agentId)}" ` +
          `title="${row.isSummarizePending ? 'Summarizing…' : 'Summarize this leaf agent'}">` +
          `${row.isSummarizePending ? 'Summarizing…' : 'Summarize'}</span>`
        : '';
      const submitBtn = row.canSubmit
        ? `<span class="atr-submit${row.isSubmitPending ? ' atr-submit-pending' : ''}" ` +
          `data-submit="${escapeHtml(row.agentId)}" ` +
          `title="${row.isSubmitPending ? 'Submitting…' : 'Submit result to parent/orchestrator'}">` +
          `${row.isSubmitPending ? '…' : '↑'}</span>`
        : '';
      const resumeBtn = row.canResume
        ? `<span class="atr-resume" data-resume="${escapeHtml(row.agentId)}" ` +
          `title="Resume this coordinator and collect child agents">Resume</span>`
        : '';
      const rowExtra = row.isSummarizePending ? ' is-summarizing' : '';
      const glyphExtra = row.running ? 'atr-blink' : row.isSummarizePending ? 'atr-summarize-pulse' : '';
      const summarizeLabel = row.isSummarizePending ? `<span class="atr-summarize-label">Summarizing…</span>` : '';
      return `<button class="agent-tree-row status-${escapeHtml(row.status)} ${row.running ? 'is-live' : ''}${rowExtra} ${isActive ? 'is-selected' : ''}" ` +
        `data-agent-id="${escapeHtml(row.agentId)}" title="${escapeAttr(row.task)}">` +
        `<span class="atr-prefix">${escapeHtml(row.prefix)}${escapeHtml(row.connector)}</span>` +
        `<span class="atr-toggle" data-toggle="${escapeHtml(row.agentId)}">${row.toggleGlyph}</span>` +
        `<span class="atr-glyph ${glyphExtra}">${row.glyph}</span>` +
        (row.autoTransferred
          ? `<span class="atr-auto" title="Model quên gọi agent_transfer — backend đã tự chuyển kết quả + artifact lên parent">⚙</span>`
          : '') +
        (row.contextGuarded
          ? `<span class="atr-guard" title="Context gần đầy (~85%) — backend đã tự ngắt và yêu cầu agent tổng hợp + agent_transfer sớm (không compact)">⏱</span>`
          : '') +
        resumeBtn +
        summarizeBtn +
        submitBtn +
        summarizeLabel +
        `<span class="atr-task">${escapeHtml(row.task)}</span>` +
        `<span class="atr-meta">${escapeHtml(row.tokStr)}${escapeHtml(row.costStr)}</span>` +
        `</button>`;
    }).join('');
  }

  function onAgentsSnapshot(payload) {
    if (!payload?.rootChatId) return;
    const prev = state.agentsByChat.get(payload.rootChatId) || [];
    const next = Array.isArray(payload.agents) ? payload.agents : [];
    const prevRootIds = new Set(prev.filter(a => !a.parentAgentId).map(a => a.agentId));
    const hasNewRoot = next.some(a => !a.parentAgentId && !prevRootIds.has(a.agentId));
    if (hasNewRoot && prevRootIds.size) prevRootIds.forEach(id => agentTreeCollapsed.add(id));
    if (hasNewRoot) {
      const latestRoot = next.filter(a => !a.parentAgentId)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      if (latestRoot) state.activeAgentRunByChat.set(payload.rootChatId, String(latestRoot.runId || latestRoot.agentId));
    }
    state.agentsByChat.set(payload.rootChatId, next);
    if (payload.rootChatId === state.activeChatId) {
      renderAgentDock();
      if (state.activeAgentId) updateAgentThreadBar();
    }
  }

  function onAgentHandoffUpdated(payload) {
    const chatId = payload?.rootChatId;
    if (!chatId || chatId !== state.activeChatId) return;
    const targetAgentId = payload?.targetAgentId;
    // If the target thread (parent agent or orchestrator main thread) is currently open, reload it
    if (targetAgentId && state.activeAgentId === targetAgentId) {
      openAgentThread(targetAgentId).catch(() => {});
    } else if (!targetAgentId) {
      // Target is orchestrator session. If an agent thread is open, discard the
      // stashed main DOM so Back reloads the fresh handoff instead of showing
      // the pre-submit snapshot. If main is open now, hydrate immediately.
      state.agentMainThreadNodes = null;
      if (!state.activeAgentId && state.activeChatId === chatId) {
        appendMissingTurns()
          .then(() => rpc('chats.cachedArtifacts', { chatId }))
          .then(c => { injectCachedArtifacts(chatId, c || {}); seedImageAttachKeysFromDom(); })
          .catch(() => {});
      }
    }
  }

  function onAgentPropagation(payload) {
    const chatId = payload?.rootChatId;
    if (!chatId) return;
    state.agentPropagationByChat.set(chatId, payload);
    if (payload.agentId) {
      if (['ready', 'completed', 'delivered', 'failed'].includes(payload.state)) {
        state.agentForceReturnPending.delete(payload.agentId);
      } else {
        state.agentForceReturnPending.add(payload.agentId);
      }
    }
    // Sync summarize/submit pending sets from batch propagation events
    if (payload.phase === 'summarize' && payload.agentId) {
      if (payload.status === 'running') {
        state.agentSummarizePending.add(payload.agentId);
      } else {
        state.agentSummarizePending.delete(payload.agentId);
      }
    }
    if (payload.phase === 'submit' && payload.agentId) {
      if (payload.status === 'running') {
        state.agentSubmitPending.add(payload.agentId);
      } else {
        state.agentSubmitPending.delete(payload.agentId);
      }
    }
    if (chatId === state.activeChatId) {
      renderAgentDock();
      // Show batch progress in propagation status bar
      if (payload.phase && els.agentPropagationStatus) {
        const { phase, agentId, status, done, total, error } = payload;
        const label = phase === 'summarize' ? 'Summarizing' : phase === 'submit' ? 'Submitting' :
          phase === 'parent-inference' ? 'Inferencing' : phase === 'orchestrator-inference' ? 'Orchestrator' : 'Processing';
        const progress = (total > 0) ? ` (${done}/${total})` : (done != null) ? ` (${done})` : '';
        const agentLabel = agentId ? ` · ${agentId.slice(0, 8)}` : '';
        const statusText = status === 'error' ? ` ✗ ${error || ''}` : status === 'done' ? ' ✓' : '…';
        els.agentPropagationStatus.hidden = false;
        els.agentPropagationStatus.textContent = `${label}${agentLabel}${statusText}${progress}`;
      }
      if (state.activeAgentId && state.agentSummarizePending.has(state.activeAgentId)) {
        updateAgentThreadBar();
      }
    }
  }

  function onAgentLifecycle(event) {
    if (!event?.rootChatId) return;
    const status = event.status || event.payload?.status;
    const terminal = ['completed', 'released', 'error', 'cancelled', 'limit_reached'].includes(event.type) ||
      ['completed', 'released', 'error', 'cancelled', 'limit_reached'].includes(status);
    if (event.agentId && terminal) clearAgentLiveBuffer(event.rootChatId, event.agentId);
    rpc('agents.tree', { chatId: event.rootChatId }).then(r => {
      if (r?.agents) onAgentsSnapshot({ rootChatId: event.rootChatId, agents: r.agents });
      if (event.agentId !== state.activeAgentId) return;
      if (event.type === 'completed' || event.type === 'released') {
        openAgentThread(event.agentId).catch(() => {});
      } else if (['error', 'cancelled', 'limit_reached'].includes(status)) {
        closeAgentThread();
      }
    }).catch(() => {});
  }

  // Backend context guard fired for an agent (runtime ≥ ~85% of its window):
  // it was auto-interrupted and told to synthesize + agent_transfer now. The
  // accompanying agents.snapshot repaints the ⏱ dock badge; this is the
  // in-your-face notice the user asked for.
  function onAgentContextGuard(ev) {
    if (!ev) return;
    const p = ev.payload || {};
    const idTail = String(ev.agentId || '').slice(-6);
    const usedK = Math.round((p.tokens || 0) / 1000);
    const maxK  = Math.round((p.max || 0) / 1000);
    showToast(
      `⏱ Agent ${idTail}: context ~${usedK}k/${maxK}k (≥85%) — backend đã tự ngắt & yêu cầu tổng hợp + agent_transfer sớm`,
      'warn', 6000,
    );
  }

  function clearAgentLiveBuffer(rootChatId, agentId) {
    state.agentPendingBlocks.delete(`${rootChatId}:${agentId}:token`);
    state.agentPendingBlocks.delete(`${rootChatId}:${agentId}:thinking`);
    state.agentToolEvents.delete(`${rootChatId}:${agentId}`);
    if (rootChatId === state.activeChatId && agentId === state.activeAgentId) {
      els.threadInner.querySelector(`.agent-live-blocks[data-agent-id="${cssEscape(agentId)}"]`)?.remove();
    }
  }

  function onAgentChunk(event) {
    if (!event?.agentId) return;
    const p = event.payload || {};
    if (p.type !== 'token' && p.type !== 'thinking') return;
    const key = `${event.rootChatId}:${event.agentId}:${p.type}`;
    const current = state.agentPendingBlocks.get(key) || '';
    state.agentPendingBlocks.set(key, current + (p.text || ''));
    if (event.rootChatId !== state.activeChatId || event.agentId !== state.activeAgentId) return;
    renderAgentLiveBlocks(event.agentId);
  }

  function renderAgentLiveBlocks(agentId) {
    const thinking = state.agentPendingBlocks.get(`${state.activeChatId}:${agentId}:thinking`) || '';
    const text = state.agentPendingBlocks.get(`${state.activeChatId}:${agentId}:token`) || '';
    const tools = state.agentToolEvents.get(`${state.activeChatId}:${agentId}`) || [];
    if (!thinking && !text && !tools.length) return;
    let wrap = els.threadInner.querySelector(`.agent-live-blocks[data-agent-id="${cssEscape(agentId)}"]`);
    if (!wrap) {
      els.threadInner.querySelector('.agent-waiting-view')?.remove();
      wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant agent-live-blocks';
      wrap.dataset.agentId = agentId;
      const body = document.createElement('div');
      body.className = 'msg-body';
      wrap.appendChild(body);
      els.threadInner.appendChild(wrap);
    }
    const body = wrap.querySelector('.msg-body');
    const blocks = [];
    if (thinking) blocks.push({ type: 'thinking', thinking });
    if (text) blocks.push({ type: 'text', text });
    body.innerHTML = renderBlocks(blocks);
    for (const p of tools) {
      const el = document.createElement('div');
      el.className = 'agent-tool-event';
      el.textContent = `${p.type || 'tool'} · ${p.name || ''}${p.result ? ` · ${p.result}` : ''}`;
      body.appendChild(el);
    }
    highlightCodeBlocks(body);
    scrollThreadToEnd();
  }

  function onAgentArtifact(event) {
    if (!event || event.rootChatId !== state.activeChatId || event.agentId !== state.activeAgentId) return;
    const payload = event.payload || {};
    onArtifactAttach({ ...payload, chatId: event.rootChatId, agentId: event.agentId });
  }

  function onAgentTool(event) {
    if (!event || event.rootChatId !== state.activeChatId || event.agentId !== state.activeAgentId) return;
    const p = event.payload || {};
    if (p.name === 'spawn_agents') {
      // The streamed thinking belongs to the assistant turn that just emitted
      // spawn_agents. Rehydrate that persisted turn instead of keeping a live
      // copy beside it; otherwise switching away/back shows duplicate thinking.
      clearAgentLiveBuffer(event.rootChatId, event.agentId);
      openAgentThread(event.agentId).catch(() => {});
      return;
    }
    const key = `${event.rootChatId}:${event.agentId}`;
    const list = state.agentToolEvents.get(key) || [];
    list.push(p);
    state.agentToolEvents.set(key, list.slice(-200));
    renderAgentLiveBlocks(event.agentId);
  }

  function onAgentUsage(event) {
    if (!event?.agentId) return;
    state.agentUsageById.set(event.agentId, event.payload || {});
    if (event.rootChatId === state.activeChatId) renderAgentDock();
    if (event.rootChatId !== state.activeChatId || event.agentId !== state.activeAgentId) return;
    updateAgentThreadBar(event.payload);
    applyAgentContextUsage(event.agentId, event.payload);
  }

  function applyAgentContextUsage(agentId, payload) {
    const agent = agentsForActiveChat().find(a => a.agentId === agentId);
    const usage = payload?.usage || agent?.usage || {};
    const ctxMax = payload?.contextMax || agent?.contextMax || 0;
    const total = payload?.contextUsed || (usage.inTokens || 0);
    state.agentUsageById.set(agentId, { ...payload, usage, contextMax: ctxMax, contextUsed: total });
    if (state.activeAgentId !== agentId) return;
    updateContextProgressBar({ system: 0, tools: 0, runtime: total, total, ctxMax, pct: ctxMax ? total / ctxMax : 0 });
  }

  function updateAgentThreadBar(usagePayload) {
    const agent = agentsForActiveChat().find(a => a.agentId === state.activeAgentId);
    if (!els.agentThreadBar) return;
    if (!agent) {
      els.agentThreadBar.hidden = false;
      if (els.agentCancelBtn) {
        els.agentCancelBtn.hidden = false;
        els.agentCancelBtn.disabled = false;
        els.agentCancelBtn.textContent = 'Close agent';
        els.agentCancelBtn.title = 'Close this stale agent view';
      }
      if (els.agentResumeBtn) els.agentResumeBtn.hidden = true;
      if (els.agentSubmitBtn) els.agentSubmitBtn.hidden = true;
      if (els.agentSubmitStatus) els.agentSubmitStatus.hidden = true;
      return;
    }
    els.agentThreadBar.hidden = false;
    if (els.agentCancelBtn) {
      els.agentCancelBtn.hidden = true;
      els.agentCancelBtn.disabled = true;
    }
    if (els.agentResumeBtn) {
      els.agentResumeBtn.hidden = true;
      els.agentResumeBtn.disabled = true;
    }
    const parents = [];
    let cursor = agent;
    const all = agentsForActiveChat();
    while (cursor) {
      parents.unshift(cursor);
      cursor = cursor.parentAgentId ? all.find(a => a.agentId === cursor.parentAgentId) : null;
    }
    els.agentBreadcrumb.textContent = parents.map(a => a.task || a.agentId).join(' › ');
    const status = agent.status || 'queued';
    const usage = usagePayload?.usage || agent.usage;
    const isBusy = state.agentManualStreaming || state.agentBatchRunning;
    const hasChildren = all.some(a => a.parentAgentId === agent.agentId);
    const resumable = hasChildren && ['cancelled', 'error'].includes(status);
    const cancellable = !['completed', 'released', 'limit_reached', 'cancelled', 'error'].includes(status);
    if (els.agentCancelBtn) {
      els.agentCancelBtn.hidden = !cancellable;
      els.agentCancelBtn.disabled = !cancellable;
      els.agentCancelBtn.textContent = ['queued', 'running', 'waiting'].includes(status) ? 'Cancel agent' : 'Close agent';
      els.agentCancelBtn.title = usage ? `${usage.inTokens || 0} input · ${usage.outTokens || 0} output tokens` : status;
    }
    if (els.agentResumeBtn) {
      els.agentResumeBtn.hidden = !resumable;
      els.agentResumeBtn.disabled = !resumable || isBusy;
      els.agentResumeBtn.textContent = 'Resume agent';
      els.agentResumeBtn.title = 'Resume this interrupted agent by id';
    }
    // Submit + Summarize buttons: visible for terminal agents only
    const isTerminal = ['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(status);
    if (els.agentSubmitBtn) {
      els.agentSubmitBtn.hidden = !isTerminal;
      els.agentSubmitBtn.disabled = !isTerminal || isBusy || state.agentSubmitPending.has(state.activeAgentId);
      const hasParent = !!agent.parentAgentId;
      els.agentSubmitBtn.title = hasParent ? 'Submit result to parent agent' : 'Submit result to orchestrator';
      els.agentSubmitBtn.textContent = hasParent ? 'Submit to parent ↑' : 'Submit to orchestrator ↑';
    }
    if (els.agentSubmitStatus && !els.agentSubmitStatus.hidden) {
      // keep status visible if set by submit handler
    }
  }

  async function openAgentThread(agentId) {
    if (!state.activeChatId || !agentId) return;
    const chatId = state.activeChatId;
    const viewGen = ++state.agentViewGen;
    if (!state.activeAgentId) {
      state.agentMainThreadNodes = document.createDocumentFragment();
      while (els.threadInner.firstChild) state.agentMainThreadNodes.appendChild(els.threadInner.firstChild);
    }
    state.activeAgentId = agentId;
    els.threadInner.innerHTML = '';
    // Show composer for terminal agents so the user can chat directly;
    // live agents keep composer hidden (send goes through orchestrator session).
    const _openAgent = agentsForActiveChat().find(a => a.agentId === agentId);
    const _openIsTerminal = !_openAgent || ['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(_openAgent?.status);
    if (els.composer) els.composer.hidden = !_openIsTerminal;
    if (_openIsTerminal && els.composerInput) els.composerInput.placeholder = 'Chat with agent… (Enter)';
    updateAgentThreadBar();
    applyAgentContextUsage(agentId, state.agentUsageById.get(agentId));
    const turns = await rpc('agents.turns', { chatId, agentId });
    if (viewGen !== state.agentViewGen || state.activeChatId !== chatId || state.activeAgentId !== agentId) return;
    els.threadInner.innerHTML = '';
    let lastWasAsst = false;
    for (const turn of (Array.isArray(turns) ? turns : [])) {
      if (isToolResultTurn(turn) && lastWasAsst) {
        absorbToolResultIntoLast(turn);
        continue;
      }
      appendTurnDom(turn, { agentId });
      lastWasAsst = (turn.role === 'assistant');
    }
    const agentForLive = agentsForActiveChat().find(a => a.agentId === agentId);
    const isLiveOrBusy = !!agentForLive && ['queued', 'running', 'waiting'].includes(agentForLive.status)
      || state.agentSummarizePending.has(agentId)
      || state.agentSubmitPending.has(agentId)
      || state.agentManualStreaming;
    if (Array.isArray(turns) && turns.length && !isLiveOrBusy) clearAgentLiveBuffer(chatId, agentId);
    try {
      const cached = await rpc('agents.cachedArtifacts', { chatId, agentId });
      if (viewGen === state.agentViewGen && state.activeChatId === chatId && state.activeAgentId === agentId) {
        injectCachedArtifacts(chatId, { ...(cached || {}), agentId });
        seedImageAttachKeysFromDom(els.threadInner);
        refreshArtifactGallery().catch(() => {});
      }
    } catch (e) { console.warn('[studio] agents.cachedArtifacts failed:', e); }
    if (viewGen !== state.agentViewGen || state.activeChatId !== chatId || state.activeAgentId !== agentId) return;
    updateAgentThreadBar();
    const agent = agentsForActiveChat().find(a => a.agentId === agentId);
    const isLive = !!agent && ['queued', 'running', 'waiting'].includes(agent.status);
    if (isLive) renderAgentLiveBlocks(agentId);
    if (!turns?.length && isLive && !els.threadInner.querySelector('.agent-live-blocks')) {
      els.threadInner.innerHTML = '<div class="agent-waiting-view"><span class="agent-pulse"></span> Agent context is starting…</div>';
    }
    scrollThreadToEnd(true);
  }

  function closeAgentThread() {
    if (!state.activeAgentId && !state.agentMainThreadNodes) return;
    const reloadChatId = state.activeAgentId && state.activeChatId ? state.activeChatId : null;
    ++state.agentViewGen;
    state.activeAgentId = null;
    if (els.agentThreadBar) els.agentThreadBar.hidden = true;
    if (els.agentCancelBtn) els.agentCancelBtn.hidden = true;
    if (els.agentResumeBtn) els.agentResumeBtn.hidden = true;
    if (els.composer) els.composer.hidden = false;
    if (els.composerInput) els.composerInput.placeholder = 'Message Aether… (drag files here)';
    if (reloadChatId) {
      state.agentMainThreadNodes = null;
      state.activeChatId = null;
      loadChat(reloadChatId).catch(e => console.warn('[studio] reload after agent close failed:', e));
      return;
    }
    els.threadInner.innerHTML = '';
    if (state.agentMainThreadNodes) els.threadInner.appendChild(state.agentMainThreadNodes);
    state.agentMainThreadNodes = null;
    updateContextProgressBar(state.ctxUsage);
    renderAgentDock();
    scrollThreadToEnd(true);
  }

  els.agentDock?.addEventListener('click', (event) => {
    // Toggle collapse if the toggle glyph was clicked
    const toggleEl = event.target.closest('[data-toggle]');
    if (toggleEl?.dataset.toggle) {
      const id = toggleEl.dataset.toggle;
      const btn = toggleEl.closest('[data-agent-id]');
      if (btn?.classList.contains('agent-tree-row')) {
        event.stopPropagation();
        if (agentTreeCollapsed.has(id)) agentTreeCollapsed.delete(id);
        else agentTreeCollapsed.add(id);
        renderAgentDock();
        return;
      }
    }
    // Per-row Summarize button
    const summarizeEl = event.target.closest('[data-summarize]');
    if (summarizeEl?.dataset.summarize) {
      event.stopPropagation();
      const agentId = summarizeEl.dataset.summarize;
      const chatId = state.activeChatId;
      if (!chatId) return;
      if (state.agentSummarizePending.has(agentId) || state.agentManualStreaming) return;
      doSummarizeAgent(chatId, agentId, state.activeAgentId === agentId ? els.agentSummarizeStatus : undefined);
      return;
    }

    // Per-row Resume button for interrupted coordinators
    const resumeEl = event.target.closest('[data-resume]');
    if (resumeEl?.dataset.resume) {
      event.stopPropagation();
      const agentId = resumeEl.dataset.resume;
      const chatId = state.activeChatId;
      if (!chatId || state.agentBatchRunning || state.agentManualStreaming) return;
      resumeEl.textContent = 'Resuming…';
      resumeEl.classList.add('atr-resume-pending');
      rpc('agents.resume', { chatId, agentId })
        .then(() => rpc('agents.tree', { chatId }).catch(() => null))
        .then(tree => { if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents }); })
        .catch(e => {
          console.warn('[studio] agent resume failed:', e);
          renderAgentDock();
        });
      return;
    }

    // Per-row Submit button
    const submitEl = event.target.closest('[data-submit]');
    if (submitEl?.dataset.submit) {
      event.stopPropagation();
      const agentId = submitEl.dataset.submit;
      const chatId = state.activeChatId;
      if (!chatId) return;
      if (state.agentSubmitPending.has(agentId)) return;
      doSubmitAgent(chatId, agentId);
      return;
    }

    const button = event.target.closest('[data-agent-id]');
    if (button?.dataset.agentId) openAgentThread(button.dataset.agentId);
  });
  els.agentBackBtn?.addEventListener('click', closeAgentThread);
  els.agentResumeBtn?.addEventListener('click', async () => {
    const agentId = state.activeAgentId;
    const chatId = state.activeChatId;
    if (!agentId || !chatId || state.agentManualStreaming) return;
    els.agentResumeBtn.disabled = true;
    els.agentResumeBtn.textContent = 'Resuming…';
    try {
      const result = await rpc('agents.resume', { chatId, agentId });
      const tree = await rpc('agents.tree', { chatId }).catch(() => null);
      if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
      if (!result?.ok && state.activeChatId === chatId && state.activeAgentId === agentId) updateAgentThreadBar();
    } catch (e) {
      console.warn('[studio] agent resume failed:', e);
      updateAgentThreadBar();
    } finally {
      if (state.activeChatId === chatId && state.activeAgentId === agentId) updateAgentThreadBar();
    }
  });

  els.agentCancelBtn?.addEventListener('click', async () => {
    if (!state.activeAgentId) return;
    if (!state.activeChatId) {
      closeAgentThread();
      return;
    }
    const chatId = state.activeChatId;
    const agentId = state.activeAgentId;
    const agent = agentsForActiveChat().find(a => a.agentId === agentId);
    const status = agent?.status || 'cancelled';
    const isTerminal = !agent || ['completed', 'cancelled', 'error', 'released', 'limit_reached'].includes(status);
    if (isTerminal) {
      // Dismiss the subtree (removes card from dock) then close the thread view
      els.agentCancelBtn.hidden = false;
      els.agentCancelBtn.disabled = true;
      try {
        await rpc('agents.dismiss', { chatId, agentId }).catch(() => {});
        const tree = await rpc('agents.tree', { chatId }).catch(() => null);
        if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
      } finally {
        closeAgentThread();
      }
      return;
    }
    els.agentCancelBtn.hidden = false;
    els.agentCancelBtn.disabled = true;
    try {
      const res = await rpc('agents.cancel', { chatId, agentId });
      const tree = await rpc('agents.tree', { chatId }).catch(() => null);
      if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
      if (!res?.ok && state.activeChatId === chatId && state.activeAgentId === agentId) updateAgentThreadBar();
    } catch (e) {
      console.warn('[studio] agent cancel failed:', e);
      updateAgentThreadBar();
    } finally {
      if (state.activeChatId === chatId && state.activeAgentId === agentId) els.agentCancelBtn.disabled = false;
    }
  });

  // Thread-bar Submit button
  els.agentSubmitBtn?.addEventListener('click', () => {
    const agentId = state.activeAgentId;
    const chatId = state.activeChatId;
    if (!agentId || !chatId) return;
    if (state.agentSubmitPending.has(agentId)) return;
    doSubmitAgent(chatId, agentId, els.agentSubmitStatus);
  });

  /** Submit one edge: agentId result → direct parent (or orchestrator if root).
   *  statusEl is optional — thread-bar span; dock row uses its own inline state. */
  async function doSubmitAgent(chatId, agentId, statusEl) {
    state.agentSubmitPending.add(agentId);
    renderAgentDock();
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Submitting…'; }
    if (state.activeAgentId === agentId) updateAgentThreadBar();
    try {
      const submittedAgent = agentsForActiveChat().find(a => a.agentId === agentId);
      const isRootSubmit = submittedAgent && !submittedAgent.parentAgentId;
      if (isRootSubmit && state.activeAgentId === agentId) {
        state.agentMainThreadNodes = null;
        closeAgentThread();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const result = await rpc('agents.submit', { chatId, agentId, infer: true });
      if (result?.error) {
        if (statusEl) statusEl.textContent = 'Submit failed';
        console.warn('[studio] agents.submit error:', result.error);
      } else {
        if (statusEl) statusEl.textContent = result?.inferred ? 'Submitted + inferred ✓' : 'Submitted ✓';
        // Refresh tree so target agent shows pending handoff
        const tree = await rpc('agents.tree', { chatId }).catch(() => null);
        if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
        // A root submit mutates orchestrator history while its DOM is stashed.
        // Rehydrate on Back so the pending handoff card is immediately visible.
        if (result?.targetAgentId === null) state.agentMainThreadNodes = null;
        if (result?.inferred) {
          if (result?.targetAgentId && state.activeAgentId === result.targetAgentId) await openAgentThread(result.targetAgentId).catch(() => {});
          else if (result?.targetAgentId === null) state.agentMainThreadNodes = null;
        }
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Submit failed';
      console.warn('[studio] agents.submit failed:', e);
    } finally {
      state.agentSubmitPending.delete(agentId);
      renderAgentDock();
      if (state.activeAgentId === agentId) updateAgentThreadBar();
      // Clear status after 3s
      if (statusEl) setTimeout(() => { statusEl.hidden = true; statusEl.textContent = ''; }, 3000);
    }
  }

  // Dock header Resume all button
  els.agentResumeAllBtn?.addEventListener('click', () => {
    const chatId = state.activeChatId;
    if (!chatId || state.agentBatchRunning) return;
    doResumeAll(chatId);
  });

  // Dock header Summary all leaf button
  els.agentSummaryAllBtn?.addEventListener('click', () => {
    const chatId = state.activeChatId;
    if (!chatId || state.agentBatchRunning) return;
    doSummarizeAll(chatId);
  });

  // Dock header Bottom up submit button
  els.agentSubmitAllBtn?.addEventListener('click', () => {
    const chatId = state.activeChatId;
    if (!chatId || state.agentBatchRunning) return;
    doSubmitAll(chatId);
  });

  async function doResumeAll(chatId) {
    const all = agentsForActiveChat();
    const runId = state.activeAgentRunByChat.get(chatId) || '';
    const active = runId ? all.filter(a => String(a.runId || a.agentId) === runId) : all;
    const childrenByParent = new Map();
    for (const agent of active) {
      if (!agent.parentAgentId) continue;
      if (!childrenByParent.has(agent.parentAgentId)) childrenByParent.set(agent.parentAgentId, []);
      childrenByParent.get(agent.parentAgentId).push(agent);
    }
    const coordinatorIds = new Set();
    for (const agent of active) {
      let cursor = agent;
      let topCoordinator = null;
      while (cursor?.parentAgentId) {
        const parent = active.find(a => a.agentId === cursor.parentAgentId);
        if (parent && childrenByParent.has(parent.agentId)) topCoordinator = parent;
        cursor = parent;
      }
      if (topCoordinator && ['cancelled', 'error'].includes(agent.status)) coordinatorIds.add(topCoordinator.agentId);
    }
    const targets = active.filter(a => coordinatorIds.has(a.agentId));
    state.agentBatchRunning = true;
    renderAgentDock();
    if (els.agentResumeAllBtn) { els.agentResumeAllBtn.disabled = true; els.agentResumeAllBtn.textContent = 'Resuming…'; }
    if (els.agentSummaryAllBtn) els.agentSummaryAllBtn.disabled = true;
    if (els.agentSubmitAllBtn) els.agentSubmitAllBtn.disabled = true;
    if (els.agentPropagationStatus) { els.agentPropagationStatus.hidden = false; els.agentPropagationStatus.textContent = `Resuming ${targets.length} agent${targets.length === 1 ? '' : 's'}…`; }
    let resumed = 0;
    let failed = 0;
    try {
      for (const agent of targets) {
        const result = await rpc('agents.resume', { chatId, agentId: agent.agentId }).catch(e => ({ error: String(e?.message || e) }));
        if (result?.ok) resumed++;
        else failed++;
        const tree = await rpc('agents.tree', { chatId }).catch(() => null);
        if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
      }
      if (els.agentPropagationStatus) els.agentPropagationStatus.textContent = `Resumed ${resumed}${failed ? `, ${failed} failed` : ''}`;
      if (state.activeAgentId && state.activeChatId === chatId) await openAgentThread(state.activeAgentId).catch(() => {});
    } finally {
      state.agentBatchRunning = false;
      if (els.agentResumeAllBtn) { els.agentResumeAllBtn.disabled = false; els.agentResumeAllBtn.textContent = 'Resume all'; }
      if (els.agentSummaryAllBtn) els.agentSummaryAllBtn.disabled = false;
      if (els.agentSubmitAllBtn) els.agentSubmitAllBtn.disabled = false;
      renderAgentDock();
      setTimeout(() => { if (els.agentPropagationStatus && !state.agentBatchRunning) els.agentPropagationStatus.hidden = true; }, 5000);
    }
  }

  /** Summarize one agent — runs one inference turn with a full-session summary prompt. */
  async function doSummarizeAgent(chatId, agentId, statusEl) {
    state.agentSummarizePending.add(agentId);
    state.agentManualStreaming = true;
    refreshComposerButtons();
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = 'Summarizing…'; }
    if (state.activeAgentId === agentId) updateAgentThreadBar();
    renderAgentDock(); // show summarize animation on dock row immediately

    // Reload existing turns BEFORE the RPC so the user-bubble from the summary
    // prompt is rendered in a DOM that already matches persisted state.
    // This prevents the switch-away / switch-back re-render from injecting the
    // prompt card mid-stream and breaking the SSE flow continuity.
    if (state.activeChatId === chatId && state.activeAgentId === agentId) {
      const preTurns = await rpc('agents.turns', { chatId, agentId }).catch(() => null);
      if (state.activeChatId === chatId && state.activeAgentId === agentId && Array.isArray(preTurns)) {
        els.threadInner.innerHTML = '';
        let lastWasAsst = false;
        for (const turn of preTurns) {
          if (isToolResultTurn(turn) && lastWasAsst) { absorbToolResultIntoLast(turn); continue; }
          appendTurnDom(turn, { agentId });
          lastWasAsst = (turn.role === 'assistant');
        }
        scrollThreadToEnd(true);
      }
    }

    try {
      const result = await rpc('agents.summarize', { chatId, agentId });
      if (result?.error) {
        if (statusEl) statusEl.textContent = 'Summary failed';
        console.warn('[studio] agents.summarize error:', result.error);
      } else {
        if (statusEl) statusEl.textContent = 'Summarized ✓';
        // Reload thread to show the final persisted summary bubble
        if (state.activeChatId === chatId && state.activeAgentId === agentId) {
          const viewGen = state.agentViewGen;
          const turns = await rpc('agents.turns', { chatId, agentId }).catch(() => null);
          if (viewGen === state.agentViewGen && state.activeChatId === chatId && state.activeAgentId === agentId) {
            els.threadInner.innerHTML = '';
            let lastWasAsst = false;
            for (const turn of (Array.isArray(turns) ? turns : [])) {
              if (isToolResultTurn(turn) && lastWasAsst) { absorbToolResultIntoLast(turn); continue; }
              appendTurnDom(turn, { agentId });
              lastWasAsst = (turn.role === 'assistant');
            }
            clearAgentLiveBuffer(chatId, agentId);
            scrollThreadToEnd(true);
          }
        }
        const tree = await rpc('agents.tree', { chatId }).catch(() => null);
        if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
        updateAgentThreadBar();
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Summary failed';
      console.warn('[studio] agents.summarize failed:', e);
    } finally {
      state.agentSummarizePending.delete(agentId);
      state.agentManualStreaming = false;
      refreshComposerButtons();
      renderAgentDock(); // clear summarize animation
      if (state.activeAgentId === agentId) updateAgentThreadBar();
      if (statusEl) setTimeout(() => { if (statusEl.textContent !== 'Summarizing…') { statusEl.hidden = true; statusEl.textContent = ''; } }, 4000);
    }
  }

  /** Batch summarize all terminal agents. */
  async function doSummarizeAll(chatId) {
    state.agentBatchRunning = true;
    renderAgentDock();
    if (els.agentSummaryAllBtn) { els.agentSummaryAllBtn.disabled = true; els.agentSummaryAllBtn.textContent = 'Summarizing…'; }
    if (els.agentSubmitAllBtn) els.agentSubmitAllBtn.disabled = true;
    if (els.agentPropagationStatus) { els.agentPropagationStatus.hidden = false; els.agentPropagationStatus.textContent = 'Starting batch summarize…'; }
    try {
      const runId = state.activeAgentRunByChat.get(chatId) || '';
      const result = await rpc('agents.summarizeAll', { chatId, runId });
      const msg = result?.error ? `Summary all leaf failed` : `Summarized ${result?.summarized ?? 0} agents${result?.failed ? `, ${result.failed} failed` : ''}`;
      if (els.agentPropagationStatus) els.agentPropagationStatus.textContent = msg;
      const tree = await rpc('agents.tree', { chatId }).catch(() => null);
      if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
      if (state.activeAgentId && state.activeChatId === chatId) {
        await openAgentThread(state.activeAgentId).catch(() => {});
      }
    } catch (e) {
      if (els.agentPropagationStatus) els.agentPropagationStatus.textContent = 'Summary all leaf failed';
      console.warn('[studio] agents.summarizeAll failed:', e);
    } finally {
      state.agentBatchRunning = false;
      if (els.agentSummaryAllBtn) { els.agentSummaryAllBtn.disabled = false; els.agentSummaryAllBtn.textContent = 'Summary all leaf'; }
      if (els.agentSubmitAllBtn) els.agentSubmitAllBtn.disabled = false;
      renderAgentDock();
      setTimeout(() => { if (els.agentPropagationStatus && !state.agentBatchRunning) els.agentPropagationStatus.hidden = true; }, 5000);
    }
  }

  /** Bottom-up submit with auto parent inference. */
  async function doSubmitAll(chatId) {
    state.agentBatchRunning = true;
    renderAgentDock();
    if (els.agentSubmitAllBtn) { els.agentSubmitAllBtn.disabled = true; els.agentSubmitAllBtn.textContent = 'Submitting…'; }
    if (els.agentSummaryAllBtn) els.agentSummaryAllBtn.disabled = true;
    if (els.agentPropagationStatus) { els.agentPropagationStatus.hidden = false; els.agentPropagationStatus.textContent = 'Starting bottom-up submit…'; }
    try {
      const runId = state.activeAgentRunByChat.get(chatId) || '';
      if (state.activeAgentId && state.activeChatId === chatId) {
        state.agentMainThreadNodes = null;
        closeAgentThread();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const result = await rpc('agents.submitAll', { chatId, runId });
      const msg = result?.error ? `Bottom up submit failed` : `Submitted ${result?.submitted ?? 0}${result?.failed ? `, ${result.failed} failed` : ''} — orchestrator inference complete`;
      if (els.agentPropagationStatus) els.agentPropagationStatus.textContent = msg;
      // Refresh tree and main thread DOM
      const tree = await rpc('agents.tree', { chatId }).catch(() => null);
      if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
      state.agentMainThreadNodes = null; // force main thread reload on Back
      if (!state.activeAgentId && state.activeChatId === chatId) {
        await appendMissingTurns().catch(() => {});
        await rpc('chats.cachedArtifacts', { chatId })
          .then(c => { injectCachedArtifacts(chatId, c || {}); seedImageAttachKeysFromDom(); })
          .catch(() => {});
      }
    } catch (e) {
      if (els.agentPropagationStatus) els.agentPropagationStatus.textContent = 'Bottom up submit failed';
      console.warn('[studio] agents.submitAll failed:', e);
    } finally {
      state.agentBatchRunning = false;
      if (els.agentSubmitAllBtn) { els.agentSubmitAllBtn.disabled = false; els.agentSubmitAllBtn.textContent = 'Bottom up submit'; }
      if (els.agentSummaryAllBtn) els.agentSummaryAllBtn.disabled = false;
      renderAgentDock();
      setTimeout(() => { if (els.agentPropagationStatus && !state.agentBatchRunning) els.agentPropagationStatus.hidden = true; }, 5000);
    }
  }

  // Collapse/expand the agent dock panel
  els.agentDockCollapseBtn?.addEventListener('click', () => {
    const monitor = els.agentMonitor;
    if (!monitor) return;
    const collapsed = monitor.classList.contains('is-collapsed');
    monitor.classList.remove('is-collapsing', 'is-expanding', 'is-collapsed');
    if (collapsed) {
      // Expand: pop up from bottom
      monitor.classList.add('is-expanding');
      els.agentDockCollapseBtn.textContent = '▲';
      els.agentDockCollapseBtn.title = 'Collapse agent panel';
      monitor.addEventListener('animationend', () => {
        monitor.classList.remove('is-expanding');
      }, { once: true });
    } else {
      // Collapse: slide closed top-to-bottom
      monitor.classList.add('is-collapsing');
      els.agentDockCollapseBtn.textContent = '▼';
      els.agentDockCollapseBtn.title = 'Expand agent panel';
      monitor.addEventListener('animationend', () => {
        monitor.classList.remove('is-collapsing');
        monitor.classList.add('is-collapsed');
      }, { once: true });
    }
  });

  // "Close all" button on agent dock header — dismisses entire agent tree
  els.agentDockHead?.addEventListener('click', async (e) => {
    const chatId = state.activeChatId;
    if (!chatId) return;

    // Close all — requires explicit destructive confirmation
    if (!e.target.closest('#agentDismissAllBtn')) return;
    const ok = await showConfirmModal(
      'Delete all agents?',
      'This will stop all running agents and remove every agent card. This cannot be undone.',
      { okText: 'Delete all agents', danger: true }
    );
    if (!ok) return;
    const btn = document.getElementById('agentDismissAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      await rpc('agents.dismissAll', { chatId }).catch(() => {});
      const tree = await rpc('agents.tree', { chatId }).catch(() => null);
      if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
    } finally {
      if (state.activeChatId === chatId && state.activeAgentId) closeAgentThread();
    }
  });

  /* ── Chat thread render ─────────────────────────────────────────── */
  async function loadChat(chatId) {
    if (chatId === state.activeChatId && state.view === 'chat') {
      if (state.activeAgentId) {
        closeAgentThread();
        state.activeChatId = null;
      } else {
        return;
      }
    }
    // Before nuking threadInner, detach any in-flight streaming bubble that
    // belongs to a non-active chat (parallel chats in v0.2.13). We can't
    // just innerHTML='' because that destroys the live DOM nodes the chunk
    // pipeline is mutating.
    for (const [otherChatId, asst] of state.pendingAsstByChat.entries()) {
      if (asst.wrap && asst.wrap.parentNode) {
        try { asst.wrap.parentNode.removeChild(asst.wrap); } catch {}
      }
    }
    state.activeChatId = chatId;
    state.activeAgentId = null;
    state.agentMainThreadNodes = null;
    ++state.agentViewGen;
    if (els.agentThreadBar) els.agentThreadBar.hidden = true;
    if (els.composer) els.composer.hidden = false;
    state.view = 'chat';
    refreshProjectLabel();
    applyTemperatureForChat(chatId);
    // Image-attach dedupe is keyed by (chatId, filename) — when we re-enter
    // a chat we want the next stream's images to render again, so wipe the
    // memory of cards that may already be in the DOM (loadTurns repaints).
    state.loadGen = (state.loadGen || 0) + 1;
    const myGen = state.loadGen;
    state.attachedImageKeys = new Set();
    renderRecent();
    rpc('agents.tree', { chatId }).then(r => {
      if (r?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: r.agents });
    }).catch(() => {});
    const turns = await rpc('chats.turns', { chatId });
    // Another loadChat started while we awaited — abort; that one owns the DOM now.
    if (myGen !== state.loadGen) return;
    els.threadInner.innerHTML = '';
    if (!turns.length) {
      // Empty conversation → show a welcome card with starter prompts.
      // Clicking a chip drops the text into the composer ready to send.
      els.threadInner.innerHTML = renderWelcomeCard();
      bindWelcomeChips();
      setEmptyChatMode(true);
    } else {
      setEmptyChatMode(false);
      // Visual grouping: a "tool-result turn" (user role, content is all
      // tool_result blocks) is rendered inline with the previous assistant
      // turn so user sees ONE card per tool call instead of two boxes.
      // Edge case: if a tool-result turn appears WITHOUT a prior assistant
      // (test fixtures or corrupt history), render it as its own bubble.
      let lastWasAsst = false;
      for (let k = 0; k < turns.length; k++) {
        const t = turns[k];
        try {
          // 0.4.163 — synthetic user turns (continuation hints / outer-loop
          // "(continue)") are internal signals to the model, not real user
          // messages. Render as a compact foldable card attached to the
          // previous assistant bubble; do NOT create a separate user bubble.
          // 0.4.182 — skip the END_MARKER_NUDGE hint on replay to match the
          // live-stream suppression: it's an internal housekeeping pass and
          // its card would render as an ownerless orphan card above every
          // reloaded chat that ever hit an end_turn without [END].
          // 0.4.241 — synthetic flag may be missing on legacy or edge-case
          // rows (JSONL rewrite paths that dropped it, or old chats). Also
          // pattern-detect the two synthetic hints so they never render as
          // a real user bubble. `t.kind==='compact'` still routed to the
          // persistent systemNote card path below.
          if (t.role === 'user') {
            const rawText = typeof t.content === 'string'
              ? t.content
              : (Array.isArray(t.content)
                  ? t.content.map(b => (b && b.type === 'text' ? b.text : '')).join('')
                  : '');
            const looksLikeHint =
              /^\(SYSTEM: your prior segment used the entire output budget/.test(rawText) ||
              /^\(continue — pick up where you left off/.test(rawText) ||
              /^\(continue — your last turn ended without an \[END\] marker/.test(rawText) ||
              rawText === '(continue)';
            if ((t.synthetic || looksLikeHint)) {
              if (t.kind === 'compact') continue;
              if (!/last turn ended without an \[END\] marker/.test(rawText)) {
                renderContinuationHintCard(rawText, { turnId: t.id });
              }
              continue;
            }
          }
          if (isToolResultTurn(t)) {
            if (lastWasAsst) {
              absorbToolResultIntoLast(t);
            } else {
              appendTurnDom(t);   // standalone — no asst above to merge into
            }
            continue;
          }
          appendTurnDom(t);
          lastWasAsst = (t.role === 'assistant');
        } catch (err) {
          console.warn('[studio] failed to replay turn', t && t.id, err);
          const wrap = document.createElement('div');
          wrap.className = 'msg msg-assistant';
          if (t?.id !== undefined) wrap.dataset.turnId = String(t.id);
          const body = document.createElement('div');
          body.className = 'msg-body msg-error';
          body.textContent = `Could not render saved turn ${t?.id ?? k}: ${err && err.message ? err.message : err}`;
          wrap.appendChild(body);
          els.threadInner.appendChild(wrap);
          lastWasAsst = (t && t.role === 'assistant');
        }
      }
    }
    // If THIS chat is mid-stream in the background, reattach its in-flight
    // bubble so the user sees the live progress (issue #2 in 0.2.13 — parallel chats).
    const pending = state.pendingAsstByChat.get(chatId);
    if (pending && pending.wrap && !pending.wrap.isConnected) {
      els.threadInner.appendChild(pending.wrap);
      setTimeout(() => {
        if (state.activeChatId === chatId && state.loadGen === myGen) {
          rpc('chats.cachedArtifacts', { chatId })
            .then(c => injectCachedArtifacts(chatId, c || {}))
            .catch(() => {});
        }
      }, 2500);
    }
    // 0.4.155 — if this chat has a compact systemnote, drop a read-only
    // summary card at the TOP of the thread so the user can expand it and
    // see what was compacted. Card is idempotent per reload (removed then
    // re-added). Uses the same .msg-compact-card styling as the live one.
    try {
      const noteR = await rpc('chats.systemNote', { chatId });
      if (myGen !== state.loadGen) return;
      const noteText = noteR && noteR.ok ? (noteR.note || '') : '';
      const boundary = noteR && noteR.ok ? (noteR.boundary || 0) : 0;
      renderSystemNoteCard(chatId, noteText, boundary, noteR || {});
      refreshContextUsage();
    } catch (e) { console.warn('[studio] systemNote fetch failed:', e); }
    if (myGen !== state.loadGen) return;
    scrollThreadToEnd(true);   // chat-switch always re-arms follow
    refreshComposerButtons();
    // 0.4.93 — synchronously fetch cached artifact metadata (per tool_use_id)
    // and inject cards inline. Replaces the async broadcast-based replay
    // (which raced the render loop — see 0.4.92 attempt). Cards are built
    // directly from the DB reply, no event pipeline involved.
    // 0.4.121 — MUST run before the memcard hydration loop below. When the
    // memcard lands into the .msg-artifact-strip first, cached tool-result
    // images (which insert into the same strip) end up AFTER it — the
    // memcard visibly separates the tool_result from its image (screenshot
    // 42). Running injectCachedArtifacts first keeps the strip in the
    // natural order: tool_use → tool_result → image → memcard.
    try {
      const cached = await rpc('chats.cachedArtifacts', { chatId });
      if (myGen !== state.loadGen) return;
      injectCachedArtifacts(chatId, cached || {});
      seedImageAttachKeysFromDom();
    } catch (e) { console.warn('[studio] chats.cachedArtifacts failed:', e); }
    // Browser may finish/persist a turn while the VS Code webview is closed or
    // booting. Do a delayed source-of-truth hydration pass so reopening the
    // extension catches assistant turns/artifacts that landed just after the
    // initial chats.turns/chats.cachedArtifacts reads.
    setTimeout(() => {
      if (state.activeChatId !== chatId || state.loadGen !== myGen) return;
      appendMissingTurns().catch(e => console.warn('[studio] delayed hydrate failed:', e));
      rpc('chats.cachedArtifacts', { chatId })
        .then(c => { injectCachedArtifacts(chatId, c || {}); seedImageAttachKeysFromDom(); refreshArtifactGallery().catch(() => {}); })
        .catch(() => {});
      refreshContextUsage().catch(() => {});
    }, 1500);
    // 0.4.115 — reload path: hydrate a per-turn memory card for EVERY
    // assistant bubble in the thread (not just the last). Each card polls
    // memory.recent with its own bubble.turnId — backend upper-bounds by
    // that turn's ts so the card only surfaces the observation authored
    // during that specific turn. Prior 0.4.109 behaviour left older
    // bubbles cardless (screenshot 33).
    // 0.4.118 — a multi-iter turn produces adjacent .msg-assistant
    // bubbles (iter 1 with thinking+text+tool_use, tool_result absorbed
    // in-place, then iter 2 with final text). Both have .blk-text, so
    // 0.4.117's text-filter didn't dedupe. The observation was written
    // AFTER the final iter, so only the last asst bubble in a contiguous
    // group should carry the memcard. A bubble whose next sibling is
    // ALSO .msg-assistant is an intermediate iter → skip.
    // 0.4.119 — probe backend once for the set of turnIds that actually
    // have an observation/summary. Older asst bubbles with no memory
    // data were showing a stuck "Refreshing…" / "Waiting for proxy
    // container (2/40)" placeholder because each card kicked off a
    // 40 × 3s poll loop against an empty backend. Only inject a card
    // for bubbles whose turnId is in the set.
    // 0.4.143 — was gated on `state.activeChatId === chatId`. If a boot
    // race set activeChatId to a different chat between line 1412 and
    // here, the hydration would silently no-op. Log the state and always
    // run hydration for `chatId` (the loadChat argument) — the hydrate
    // pass targets bubbles inside els.threadInner which was just
    // populated for that chatId, so it's safe even if the user has since
    // switched away.
    console.log('[studio] memcard hydrate begin', {
      chatId,
      active: state.activeChatId,
      bubbles: els.threadInner.querySelectorAll('.msg-assistant').length,
    });
    {
      // 0.4.141 — query turnIdsForChat but do NOT block hydration on it.
      // Kick off the hydration loop immediately using either the fetched
      // filter set (if it arrives fast) or a null fallback (hydrate all
      // eligible bubbles). Then, once the RPC resolves later, prune cards
      // whose turnId is not in the confirmed set. This eliminates the
      // race that was making the card disappear after v0.4.139's retry
      // loop deferred hydration by up to 7s.
      // 0.4.183 — restore per-turn memcards. Each eligible asst bubble
      // gets its own card if the worker persisted an observation for
      // that turn. Optimistic pass (filterSet=null) decorates only the
      // most recent bubble so we don't flash a wall of cards while the
      // backend RPC is still in flight; the confirmed pass reads the
      // exact turnIds that produced observations and decorates every
      // matching bubble.
      const hydrateWithFilter = (filterSet) => {
        if (state.streamingChats.has(chatId) || state.pendingAsstByChat.has(chatId)) return;
        const asstBubbles = els.threadInner.querySelectorAll('.msg-assistant');
        // An asst bubble is an intermediate continuation segment if its
        // next non-empty sibling is another .msg-assistant OR a
        // .msg-continuation-hint-card. Only the FINAL segment of a
        // turn group gets a memcard. Skip .msg-memory-card siblings so
        // an already-hydrated bubble doesn't mask its own segment status.
        const isIntermediateAsst = (b) => {
          let n = b.nextElementSibling;
          while (n) {
            if (n.classList) {
              if (n.classList.contains('msg-assistant')) return true;
              if (n.classList.contains('msg-continuation-hint-card')) return true;
              if (n.classList.contains('msg-memory-card')) { n = n.nextElementSibling; continue; }
            }
            return false;
          }
          return false;
        };
        let lastBubble = null;
        for (let i = asstBubbles.length - 1; i >= 0; i--) {
          const b = asstBubbles[i];
          if (b.classList.contains('streaming')) continue;
          if (isIntermediateAsst(b)) continue;
          if (b.querySelector(':scope .msg-body')) { lastBubble = b; break; }
        }
        // Sweep stale cards from intermediate segments (legacy hydrate
        // passes could have placed cards there before the guard existed).
        asstBubbles.forEach((bubble) => {
          if (isIntermediateAsst(bubble)) {
            bubble.querySelectorAll(':scope .msg-memory-card').forEach(c => c.remove());
          }
        });
        asstBubbles.forEach((bubble) => {
          if (bubble.querySelector(':scope .msg-memory-card')) {
            // Prune cards for turns the worker has now confirmed produced
            // no observation. Only prune when the filter has landed AND
            // this bubble's tid is strictly below the max known tid — a
            // brand-new turn without an observation yet stays as
            // optimistic.
            if (filterSet && filterSet.size > 0) {
              const tid = Number(bubble.dataset.turnId);
              const maxKnown = Math.max(...filterSet);
              if (Number.isFinite(tid) && tid < maxKnown && !filterSet.has(tid)) {
                bubble.querySelectorAll(':scope .msg-memory-card').forEach(c => c.remove());
              }
            }
            return;
          }
          if (!bubble.querySelector(':scope .msg-body')) return;
          if (bubble.classList.contains('streaming')) return;
          if (isIntermediateAsst(bubble)) return;
          // Optimistic pass: only the last bubble; wait for confirmed
          // filter set before hydrating older bubbles.
          if (!filterSet && bubble !== lastBubble) return;
          // Confirmed pass: honour the filter for older bubbles. Widen
          // the grace window to `maxKnown - 2` so a very recent turn
          // whose observation is still summarising keeps its optimistic
          // card during retries.
          if (filterSet && filterSet.size > 0) {
            const tid = Number(bubble.dataset.turnId);
            const maxKnown = Math.max(...filterSet);
            const graceMin = maxKnown - 2;
            if (Number.isFinite(tid) && tid < graceMin && !filterSet.has(tid)) return;
          }
          try {
            onMemoryObservation({
              chatId,
              ok:           true,
              namespace:    'aura-ext',
              stopReason:   'reload',
              targetBubble: bubble,
            });
          } catch {}
        });
      };
      // First pass: optimistic hydrate without filter. Skip while this chat is
      // actively streaming; otherwise the previous completed turn can get a
      // new memcard while the current SSE turn is still in progress.
      if (!state.streamingChats.has(chatId) && !state.pendingAsstByChat.has(chatId)) hydrateWithFilter(null);
      // Then ask the backend for the confirmed set of turnIds that
      // actually have observations. Retry a few times because worker
      // cold-start may lag first reload.
      (async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            const r = await rpc('memory.turnIdsForChat', { chatId, namespace: 'aura-ext' });
            if (r && !r.error && Array.isArray(r.turnIds) && r.turnIds.length > 0) {
              if (state.activeChatId === chatId) hydrateWithFilter(new Set(r.turnIds.map(Number)));
              return;
            }
          } catch {}
          await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
        }
      })();
    }
    // Recalc ledger from saved per-turn totals. Older JSONL rows do not have
    // usage metadata, so guard every number to avoid NaN in the HUD.
    const safeNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    let totalIn = 0, totalOut = 0, totalCost = 0;
    for (const t of turns) {
      totalIn   += safeNum(t.inTokens);
      totalOut  += safeNum(t.outTokens);
      totalCost += safeNum(t.costUsd);
    }
    state.sessionCost = totalCost;
    setLedger({ in: totalIn, out: totalOut, cost: totalCost, session: totalCost });
  }

  function renderWelcomeCard() {
    const chips = [
      { ico: '•', text: 'Vẽ một con mèo dễ thương' },
      { ico: '•', text: 'Tìm giá BTC hiện tại' },
      { ico: '•', text: 'Viết script Python đọc CSV' },
      { ico: '•', text: 'Cho tôi xem những việc đã làm gần đây' },
    ];
    return `<div class="welcome-card">
      <svg class="welcome-logo" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M24 4C13 4 4 11.8 4 22c0 5.2 2.6 9.8 6.8 13L8 42l9-3.2A22.4 22.4 0 0 0 24 40c11 0 20-7.8 20-18S35 4 24 4z"/></svg>
      <h2>Hôm nay tôi giúp gì cho bạn?</h2>
      <p class="muted">Aether có thể chạy code, gen ảnh, search web, đọc file — và nhớ những phiên trước.</p>
      <div class="welcome-chips">
        ${chips.map(c => `<button class="welcome-chip" data-act="prefillComposer" data-text="${escapeAttr(c.text)}">${c.ico} <span>${escapeHtml(c.text)}</span></button>`).join('')}
      </div>
    </div>`;
  }
  function bindWelcomeChips() {
    els.threadInner.querySelectorAll('.welcome-chip').forEach(btn => {
      btn.onclick = () => {
        els.composerInput.value = btn.getAttribute('data-text') || '';
        autoGrow();
        try { els.composerInput.focus(); } catch {}
      };
    });
  }

  /** True if a turn is just a wrapper for tool_result blocks (the user-role
   *  message the streamer appends after a tool_use round). Such turns are
   *  visually merged into the preceding assistant bubble. */
  function isToolResultTurn(t) {
    if (!t || t.role !== 'user') return false;
    const c = Array.isArray(t.content) ? t.content : [];
    return c.length > 0 && c.every(b => b && b.type === 'tool_result');
  }

  /** Append the blocks of a tool-result turn into the most-recent assistant
   *  bubble. Keeps it visually inside the same card so streaming + history
   *  both show "1 card per tool call" instead of stacked boxes.
   *
   *  Bug-fix: tag the host bubble with the absorbed turn id so a later
   *  appendMissingTurns() pass can skip it. Without this tag, every new
   *  tool.done in subsequent turns re-injects the SAME tool_result blocks
   *  (file cards for previous turns' files) into the new streaming bubble —
   *  that's the "old file cards keep stacking up" symptom. */
  /** v0.4.14 — get or create a dedicated artifact strip at the bottom of
   *  an assistant bubble. File/image cards from tool results live here so
   *  the visual order is: text → tool calls → artifact cards, no matter
   *  what order the SSE stream delivers them. Mirrors Claude-native UX
   *  where attachments dock at the end of a turn rather than splice into
   *  prose. */
  function getOrCreateArtifactStrip(bodyEl) {
    if (!bodyEl) return null;
    let strip = bodyEl.querySelector(':scope > .msg-artifact-strip');
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'msg-artifact-strip';
      bodyEl.appendChild(strip);
    }
    return strip;
  }
  function isArtifactCard(el) {
    if (!el || !el.classList) return false;
    return el.classList.contains('blk-image-card')
      || el.classList.contains('blk-file-card')
      || el.classList.contains('msg-image-wrap')
      || el.classList.contains('msg-file-card');
  }
  function finalizeArtifactStrip(bodyEl) {
    const strip = bodyEl?.querySelector?.(':scope > .msg-artifact-strip');
    if (strip) bodyEl.appendChild(strip);
  }

  /** v0.4.14 — match a tool_result turn back to the assistant bubble that
   *  emitted its tool_use, NOT just "the last assistant bubble". Without
   *  this, when a tool.done from turn N races with the streaming wrap of
   *  turn N+1, file/image cards from N get absorbed into N+1's bubble —
   *  the user sees "Excel turn shows image card" symptom. We resolve the
   *  parent bubble by walking up from any `.blk-tool-use[data-tool-id=...]`
   *  that matches one of the tool_use_ids inside this tool_result turn. */
  function findParentAssistantBubble(toolResultTurn) {
    const blocks = Array.isArray(toolResultTurn?.content) ? toolResultTurn.content : [];
    for (const b of blocks) {
      const tid = b && b.type === 'tool_result' && b.tool_use_id;
      if (!tid) continue;
      const tu = els.threadInner.querySelector(
        `.msg-assistant .blk-tool-use[data-tool-id="${cssEscape(String(tid))}"]`
      );
      if (tu) return tu.closest('.msg-assistant');
    }
    return null;
  }

  function absorbToolResultIntoLast(toolResultTurn) {
    const lastMsg = findParentAssistantBubble(toolResultTurn)
      || els.threadInner.querySelector('.msg-assistant:last-of-type');
    if (!lastMsg) {
      // No prior assistant turn — fall back to a regular bubble.
      appendTurnDom(toolResultTurn);
      return;
    }
    const body = lastMsg.querySelector('.msg-body');
    if (!body) { appendTurnDom(toolResultTurn); return; }
    body.classList.add('has-absorbed-tools');
    const fragHtml = renderBlocks(toolResultTurn.content);
    const tmp = document.createElement('div');
    tmp.innerHTML = fragHtml;
    // v0.4.19 — dedup across the WHOLE thread, not just this bubble.
    // A follow-up turn (e.g. `ls -la /data/cute_cat.png`) parses out the
    // same path the previous turn already surfaced as a card; before this
    // change the user saw the image render twice. Path-based dedup is
    // global to the chat by definition — same path = same file on disk.
    const existingPaths    = new Set(
      [...els.threadInner.querySelectorAll('.blk-file-card[data-file-path]')].map(el => el.dataset.filePath),
    );
    const existingImgPaths = new Set(
      [...els.threadInner.querySelectorAll('.blk-image-card[data-img-path]')].map(el => el.dataset.imgPath),
    );
    // 0.4.131 — append every child (including artifact cards) inline to
    // body. Previously artifact cards were routed to .msg-artifact-strip at
    // bubble bottom, which pushed file cards far from the tool_result that
    // produced them (screenshot #52/#53 — pptx card sat below the memcard).
    //
    // v0.4.281 — a tool_result block must live INSIDE the same tool card
    // as its tool_use. renderBlocks wraps the results in their own
    // .tool-card sibling, so before appending we hoist each .blk-tool-result
    // out of that wrapper and splice it right after its matching
    // .blk-tool-use (found by data-tool-use-id → data-tool-id). This makes
    // the collapsed "N TOOL CALLS" card contain call+result pairs instead of
    // leaving results floating below it as loose siblings (image #147).
    const placeResultByToolUse = (resultEl) => {
      const tid = resultEl.getAttribute && resultEl.getAttribute('data-tool-use-id');
      if (!tid) return false;
      const tu = body.querySelector(`.blk-tool-use[data-tool-id="${cssEscape(String(tid))}"]`);
      if (!tu) return false;
      const card = tu.closest('.tool-card') || tu.parentElement;
      const anchor = card?.querySelector?.(`.aura-artifact-anchor[data-tool-use-id="${cssEscape(String(tid))}"]`);
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(resultEl, anchor);
      else tu.insertAdjacentElement('afterend', resultEl);
      return true;
    };
    Array.from(tmp.children).forEach((child) => {
      const fp = child.dataset && child.dataset.filePath;
      const ip = child.dataset && child.dataset.imgPath;
      if (fp && existingPaths.has(fp))     return;  // duplicate file card
      if (ip && existingImgPaths.has(ip))  return;  // duplicate image card
      // Unwrap a .tool-card sibling produced by renderBlocks(results):
      // splice each tool_result next to its tool_use; keep any leftover
      // (non-result) children appended at the end.
      if (child.classList && child.classList.contains('tool-card')) {
        const inner = Array.from(child.children);
        let placedAll = true;
        inner.forEach((el) => {
          if (el.classList && el.classList.contains('blk-tool-result')) {
            if (!placeResultByToolUse(el)) { body.appendChild(el); placedAll = false; }
          } else {
            body.appendChild(el);              // artifact card etc.
          }
        });
        if (placedAll) return;                 // wrapper fully drained
        return;
      }
      if (child.classList && child.classList.contains('blk-tool-result')) {
        if (placeResultByToolUse(child)) return;
      }
      body.appendChild(child);
    });
    hydrateImageCards(body);
    highlightCodeBlocks(body);
    if (toolResultTurn.id !== undefined) {
      lastMsg.dataset.absorbedIds = (lastMsg.dataset.absorbedIds || '') + ',' + toolResultTurn.id;
    }
  }

  function appendTurnDom(turn, scope = {}) {
    // agent-handoff: render as a distinct context card with provenance
    if (turn.kind === 'agent-handoff') {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-user msg-agent-handoff';
      if (scope.agentId) wrap.dataset.agentId = scope.agentId;
      else wrap.dataset.chatId = state.activeChatId;
      if (turn.id !== undefined) wrap.dataset.turnId = String(turn.id);
      const body = document.createElement('div');
      body.className = 'msg-body';
      // Compact header label
      const label = document.createElement('div');
      label.className = 'agent-handoff-label';
      label.textContent = 'Submitted agent context';
      body.appendChild(label);
      // Render the actual content
      const contentDiv = document.createElement('div');
      contentDiv.className = 'agent-handoff-content';
      contentDiv.innerHTML = renderBlocks(turn.content);
      body.appendChild(contentDiv);
      wrap.appendChild(body);
      // Delete button — same as standard turns
      if (turn.id !== undefined) {
        const del = document.createElement('button');
        del.className = 'msg-del';
        if (scope.agentId) {
          del.setAttribute('data-act', 'deleteAgentMessage');
          del.setAttribute('data-agent-id', String(scope.agentId));
          del.setAttribute('data-turn-id', String(turn.id));
          del.title = 'Delete this submitted context';
        } else {
          del.setAttribute('data-act', 'deleteTurn');
          del.setAttribute('data-turn-id', String(turn.id));
          del.title = 'Delete this submitted context';
        }
        del.textContent = '✕';
        wrap.appendChild(del);
      }
      els.threadInner.appendChild(wrap);
      return { wrap, body };
    }
    const wrap = document.createElement('div');
    wrap.className = `msg msg-${turn.role}`;
    // v0.4.300 — stamp the active chat id so onArtifactAttach's bubble-tail
    // fallback (`.msg-assistant[data-chat-id=…]`) can find a target on the
    // reload path. Live-stream bubbles set this (line ~1675/3388) but the
    // reload path never did, so the fallback returned empty and the artifact
    // was dropped when no tool_use anchor matched.
    if (scope.agentId) wrap.dataset.agentId = scope.agentId;
    else wrap.dataset.chatId = state.activeChatId;
    if (turn.id !== undefined) wrap.dataset.turnId = String(turn.id);
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.innerHTML = renderBlocks(turn.content);
    // 0.4.189 — user turns can carry structured attachment metadata.
    // Prepend a chip row so reload renders the same 📎/🖼️ chips the
    // optimistic path shows on send.
    if (turn.role === 'user' && Array.isArray(turn.attachments) && turn.attachments.length) {
      const chipRow = document.createElement('div');
      chipRow.className = 'msg-image-row';
      chipRow.innerHTML = turn.attachments.map(a => {
        const isImg = a.mimeType && String(a.mimeType).startsWith('image/');
        const filename = escapeHtml(a.filename || 'file');
        const size = a.sizeBytes ? ` <span class="muted small">${formatSize(a.sizeBytes)}</span>` : '';
        const notes = a.notes ? ` <span class="muted small">· ${escapeHtml(a.notes)}</span>` : '';
        return `<span class="msg-image-chip">${isImg ? '🖼️' : '📎'} ${filename}${size}${notes}</span>`;
      }).join('');
      body.prepend(chipRow);
    }
    // 0.4.131 — no longer relocate inline file/image cards to a bottom
    // .msg-artifact-strip. Artifact cards live where renderBlocks puts them
    // (inside the .tool-card wrapper, above the tool_result details), so
    // they render adjacent to the assistant text that references them.
    wrap.appendChild(body);
    highlightCodeBlocks(body);
    // Per-turn delete button — appears on hover for any settled turn that
    // has an id. Tool-result turns (paired) get cleaned up automatically
    // by the host when the parent turn is removed.
    const hasVisibleContent = !!body.querySelector(
      '.blk-text, .blk-thinking, .blk-tool-use, .blk-tool-result, .blk-image-card, .tool-card, [data-aura-artifact-id]'
    ) || !!body.textContent.trim();
    if (!hasVisibleContent && scope.agentId) return { wrap, body };
    if (turn.id !== undefined && hasVisibleContent) {
      const del = document.createElement('button');
      del.className = 'msg-del';
      if (scope.agentId) {
        del.setAttribute('data-act', 'deleteAgentMessage');
        del.setAttribute('data-agent-id', String(scope.agentId));
        del.setAttribute('data-turn-id', String(turn.id));
        del.title = 'Delete this sub-agent message';
      } else {
        del.setAttribute('data-act', 'deleteTurn');
        del.setAttribute('data-turn-id', String(turn.id));
        del.title = 'Delete this turn';
      }
      del.textContent = '✕';
      wrap.appendChild(del);
    }
    els.threadInner.appendChild(wrap);
    hydrateImageCards(body);
    if (turn.role === 'assistant' && typeof harvestArtifactsFromBody === 'function') {
      harvestArtifactsFromBody(body);
    }
    // 0.4.203 — re-check adjacency so a freshly appended tool-only bubble
    // gets folded into any existing tool-run-group above it.
    if (turn.role === 'assistant') {
      try { groupAdjacentToolOnlyBubbles(); } catch { /* renderer not ready yet */ }
    }
    return { wrap, body };
  }

  function renderBlocks(blocks) {
    // 0.4.22 — legacy turns persisted user content as a bare string
    // (`"Vẽ một con mèo"`) before the v2 block schema. Normalise so the
    // text-block path takes over; otherwise blocks.length walks the
    // string char-by-char, every `b.type` is undefined, and the user
    // bubble renders empty (the symptom user reported in the red box).
    if (typeof blocks === 'string') blocks = [{ type: 'text', text: blocks }];
    if (!Array.isArray(blocks))     blocks = [];
    // Group consecutive tool_use / tool_result blocks into a single
    // .tool-card container so multiple parallel tool calls and their
    // results visually live "in one card" — like Claude-native UX. We
    // scan once, splitting `blocks` into segments: either a run of
    // text/thinking, or a run of tool blocks.
    const segments = [];
    let i = 0;
    const isArtifactPinUse = (blk) => blk?.type === 'tool_use' && blk?.name === 'aura_artifact_pin';
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.type === 'tool_use' || b.type === 'tool_result') {
        const run = [];
        const splitSinglePin = isArtifactPinUse(b);
        while (i < blocks.length && (blocks[i].type === 'tool_use' || blocks[i].type === 'tool_result')) {
          run.push(blocks[i++]);
          // aura_artifact belongs to the tool call that just pinned it. Keep the
          // hidden anchor in the same tool-card so absorbed tool_results can be
          // inserted before it, and artifact render lands after that card.
          while (i < blocks.length && blocks[i]?.type === 'aura_artifact') run.push(blocks[i++]);
          if (splitSinglePin) break;
          if (isArtifactPinUse(blocks[i])) break;
        }
        segments.push({ kind: 'tools', run });
      } else {
        segments.push({ kind: 'one', blk: b });
        i++;
      }
    }
    return segments.map(seg => {
      if (seg.kind === 'one') return renderSingleBlock(seg.blk);
      return renderToolGroup(seg.run);
    }).join('');
  }

  function renderSingleBlock(b) {
    if (b.type === 'text') {
      // 0.4.161 — strip the [END] completion marker from the visible
      // render. The marker is a control signal for runContinuationLoop
      // to stop; user does not need to see it. Regex matches an optional
      // trailing newline + [END] + optional trailing whitespace.
      // 0.4.236 — also strip trailing [DONE] / [NEED_MORE] / [NEED_THINK]
      // (backend strips them from JSONL but live streaming shows them raw).
      // 0.4.236 — strip `[svg_ref: vN]` markers anywhere in text. Backend
      // rewrites JSONL to inline the SVG after chat.done, but the live
      // stream shows the marker verbatim; hiding it in the render avoids
      // "[svg_ref: v3][DONE]" flashing before the SVG resolves.
      let cleaned = String(b.text || '')
        .replace(/\n?\[END\]\s*$/, '')
        .replace(/\n?\[(?:DONE|NEED_MORE|NEED_THINK|BLOCKED:[^\]]*)\]\s*$/, '')
        .replace(/\n?\s*<AURA_BOARD_DRAWING_DONE\s*\/>\s*$/i, '')
        .replace(/\[svg_ref:\s*v\d+\s*\]\s*/g, '');
      if (renderMarkdown._streamingNow && cleaned.length > 12000) {
        const tail = cleaned.length > 36000 ? cleaned.slice(-36000) : cleaned;
        const prefix = cleaned.length > tail.length ? '<div class="md-stream-truncated">Streaming long output — showing latest text…</div>' : '';
        return `<div class="blk-text blk-text-stream-lite">${prefix}<pre class="md-code md-code-stream"><code>${escapeHtml(tail)}</code></pre></div>`;
      }
      return `<div class="blk-text">${renderMarkdown(cleaned)}</div>`;
    }
    if (b.type === 'thinking') {
      const txt = String(b.thinking || '');
      return `<div class="blk-thinking-inline" data-collapsed="0">
        <button class="thinking-toggle" data-act="toggleThinking" title="Collapse thinking">
          <span class="thinking-caret">▾</span> <span class="thinking-label">thinking</span>
        </button>
        <div class="thinking-body">${renderMarkdown(txt)}</div>
      </div>`;
    }
    if (b.type === 'tool_use')    return renderToolUse(b);
    if (b.type === 'tool_result') return renderToolResult(b);
    if (b.type === 'aura_artifact' && b.id) {
      const tidAttr = b.toolUseId ? ` data-tool-use-id="${escapeAttr(String(b.toolUseId))}"` : '';
      return `<span class="aura-artifact-anchor" data-aura-artifact-id="${escapeAttr(String(b.id))}"${tidAttr} hidden></span>`;
    }
    return '';
  }

  /** Wrap a run of tool_use+tool_result blocks in a single .tool-card.
   *  This is purely visual grouping — each call's expand/collapse and the
   *  result/artifact extraction still happen per-block underneath. */
  function renderToolGroup(run) {
    const items = run.map(renderSingleBlock).join('');
    const count = run.filter(b => b.type === 'tool_use').length;
    const errs  = run.filter(b => b.type === 'tool_result' && b.is_error).length;
    // v0.4.2 #F10c — collapse tool runs by default once they exceed 2
    // calls OR contain any error. The header is now a <details> summary
    // so the user can expand on demand instead of scrolling past a wall
    // of red exit-code-7 cards.
    const shouldCollapse = false;
    if (shouldCollapse && count > 1) {
      const label = errs > 0
        ? `${count} tool call${count===1?'':'s'} · ${errs} error${errs===1?'':'s'}`
        : `${count} tool calls`;
      return `<details class="tool-card${errs ? ' has-error' : ''}" data-collapsed-tools="1">
        <summary class="tool-card-head"><span class="muted small">▶ ${label}</span></summary>
        ${items}
      </details>`;
    }
    return `<div class="tool-card${errs ? ' has-error' : ''}">${items}</div>`;
  }

  function renderToolResult(b) {
    let body = b.content;
    const rawText = Array.isArray(b.content)
      ? b.content.map(x => (x && x.type === 'text' ? x.text : '')).join('')
      : (typeof b.content === 'string' ? b.content : '');
    if (typeof body === 'string') {
      try { const parsed = JSON.parse(body); body = JSON.stringify(parsed, null, 2); } catch {}
    } else {
      body = JSON.stringify(body, null, 2);
    }
    const rawSvg = rawText.trim();
    const isRawSvg = /^<svg[\s>]/i.test(rawSvg);
    if (isRawSvg) {
      body = renderMarkdown('```svg\n' + rawSvg + '\n```');
    }
    const errCls = b.is_error ? ' is-error' : '';
    // v0.4.252 — regex scan of tool_result text for image/file paths REMOVED.
    // Rationale: backend surfaceImages/imageCache already fetches every
    // artifact (image + doc) into globalStorage and fires image.attach /
    // file.attach with a webview-usable localPath. The old regex scan
    // guessed paths from stdout and rendered cards that pointed at
    // container-internal /tmp/aura-artifacts/... — the host cannot read
    // those, so cards showed "could not load: ENOENT" AND duplicated the
    // real card broadcast a moment later. Trust the broadcast, delete
    // the guess.
    let bodyText = typeof body === 'string' ? body.trim() : '';
    // Keep the child `artifacts` metadata VISIBLE in the spawn_agents
    // tool_result JSON. It used to be stripped for a cleaner display, but that
    // made the tool_result look artifact-less — so a correctly-delivered
    // transfer (bytes promoted to the parent scope, refs present in the
    // result) read as "no artifact reached the parent, yet cards render → bug".
    // The refs ARE the delivery proof; show them. Cards still render below from
    // the same refs via the spawn-tool-artifacts slot.
    const spawnArtifacts = extractSpawnToolResultArtifacts(rawText, b.tool_use_id);
    if (!b.is_error && !isRawSvg && !spawnArtifacts.length && (!bodyText || bodyText === '{}' || bodyText === '[]' || bodyText === 'null')) return '';
    const summary = summarizeToolResult(body, !!b.is_error, false);
    // Tool result raw text is hidden by default; user can click to peek.
    // Errors still auto-open so the user sees what went wrong.
    const openAttr = (b.is_error || isRawSvg) ? ' open' : '';
    const tidAttr  = b.tool_use_id ? ` data-tool-use-id="${escapeAttr(String(b.tool_use_id))}"` : '';
    const resultHtml = `<details class="blk-tool-result${errCls}${isRawSvg ? ' has-rendered-output' : ''}"${tidAttr}${openAttr}><summary>${summary.icon ? summary.icon + ' ' : ''}${summary.label}${b.is_error ? ' <span class="err-tag">error</span>' : ''}</summary>${isRawSvg ? `<div class="blk-tool-result-rendered">${body}</div>` : `<pre>${escapeHtml(body)}</pre>`}</details>`;
    // spawn_agents returns child artifacts to the orchestrator as metadata, not
    // as aura_artifact_pin blocks in the parent transcript. Render those refs
    // once after the spawn result; ordinary sandbox output still does not render.
    const artifactHtml = spawnArtifacts.length
      ? `<div class="spawn-tool-artifacts" data-tool-use-id="${escapeAttr(String(b.tool_use_id || ''))}" data-spawn-artifacts="${escapeAttr(JSON.stringify(spawnArtifacts))}"></div>`
      : '';
    return resultHtml + artifactHtml;
  }

  function extractSpawnToolResultArtifacts(rawText, toolUseId) {
    if (!rawText || !String(rawText).includes('"results"') || !String(rawText).includes('"artifacts"')) return [];
    let parsed;
    try { parsed = JSON.parse(rawText); } catch { return []; }
    const out = [];
    const seen = new Set();
    const results = Array.isArray(parsed?.results) ? parsed.results : [];
    for (const result of results) {
      const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
      for (const a of artifacts) {
        const id = String(a?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        // Respect an explicit scope on the ref: agent_transfer promotes the
        // bytes into the parent scope and stamps `sourceAgentId` accordingly —
        // '' means the file now lives in the ROOT scope (fetch with no agentId).
        // Only fall back to the producing agent's id when the ref carries no
        // sourceAgentId field at all.
        const sourceAgentId = (a && Object.prototype.hasOwnProperty.call(a, 'sourceAgentId'))
          ? String(a.sourceAgentId || '')
          : String(a?.agentId || result?.agentId || '');
        out.push({
          id,
          artifactId: id,
          name: String(a?.name || id),
          mediaType: String(a?.mediaType || 'application/octet-stream'),
          size: Number(a?.size || 0),
          savedAt: a?.savedAt ? Number(a.savedAt) : undefined,
          sourceAgentId,
          agentId: sourceAgentId || undefined,
          toolUseId: toolUseId ? String(toolUseId) : undefined,
        });
      }
    }
    return out;
  }

  function hydrateSpawnToolArtifactCards(rootEl) {
    const root = rootEl || document;
    const slots = root.querySelectorAll('.spawn-tool-artifacts[data-spawn-artifacts]:not([data-hydrated])');
    slots.forEach(slot => {
      slot.dataset.hydrated = '1';
      let artifacts = [];
      try { artifacts = JSON.parse(slot.getAttribute('data-spawn-artifacts') || '[]'); } catch { artifacts = []; }
      const tid = slot.getAttribute('data-tool-use-id') || '';
      for (const artifact of artifacts) {
        const payload = { ...artifact, chatId: state.activeChatId, toolUseId: artifact.toolUseId || tid, fromSpawnResult: true };
        // Child artifacts are surfaced to the orchestrator only through the
        // spawn_agents result metadata. Reuse the authoritative artifact path so
        // HTML loads by id/agentId (no stale "loading html…" static card) and
        // cards are inserted after the spawn result, not inside its details node.
        onArtifactAttach(payload);
      }
    });
  }

  // v0.4.253 — regex artifact scanners removed. Source of truth is now
  // exclusively the backend `image.attach` / `file.attach` broadcast (which
  // fires for both live turns AND on reload from JSONL). If a file is not
  // in the host cache <dataRoot>/chat-images/<chatId>/, no card renders.
  // Legacy card sweeper: purge any leftover data-verify="1" nodes that
  // were persisted in webview panel state from a prior extension version.
  function purgeLegacyGhostCards() {
    // v0.4.256 — widen the search to `document` (not just threadInner) since
    // panel-state-restored DOM can land anywhere; and also cover the sibling
    // `.msg-image-wrap` broadcasts that older builds produced for non-image
    // mediaTypes (docx/xlsx/pptx). Selectors:
    //   - [data-verify="1"]  legacy regex-guessed cards
    //   - .blk-file-card[data-file-path^="/tmp/aura-artifacts/"]
    //   - .blk-image-card[data-img-path^="/tmp/aura-artifacts/"]
    //   - .msg-image-wrap whose <img alt> ends in .docx/.xlsx/.pptx/.pdf
    //     (older onFileAttach used to route these through msg-image-wrap
    //      with a broken <img>, resulting in a ghost thumbnail box)
    const root = document;
    for (const el of root.querySelectorAll('[data-verify="1"]')) el.remove();
    for (const el of root.querySelectorAll(
      '.blk-image-card[data-img-path^="/tmp/aura-artifacts/"], .blk-file-card[data-file-path^="/tmp/aura-artifacts/"]',
    )) el.remove();
    const hasArtifactImage = !!root.querySelector('.art-image');
    for (const el of root.querySelectorAll('.msg-image-wrap img')) {
      const alt = (el.getAttribute('alt') || '').toLowerCase();
      const wrap = el.closest('.msg-image-wrap');
      const pathText = wrap?.querySelector?.('.msg-image-path')?.textContent || '';
      if (/\.(docx?|xlsx?|pptx?|pdf|zip|csv|tsv|json|txt|md|log)$/i.test(alt)
          || (hasArtifactImage && /\/chat-images\//.test(pathText))) {
        if (wrap) wrap.remove();
      }
    }
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  /** Syntax-highlight fenced code blocks inside `root` using highlight.js,
   *  styled to a VS Code-like palette (see .hljs rules in app.css). Runs
   *  after DOM insertion because hljs needs live <code> nodes.
   *
   *  Prose-ish languages (markdown, text, frontmatter, none) are left
   *  untouched — highlighting them tints every line one accent color and
   *  hurts readability. Real code (python, ts, bash, …) gets IDE-style
   *  token colors. hljs is vendored + lazy-loaded on first use. */
  const _HL_SKIP = new Set(['markdown', 'md', 'mermaid', 'text', 'plaintext', 'txt', '']);
  function highlightCodeBlocks(root) {
    if (!root) return;
    const codes = root.querySelectorAll('pre.md-code > code');
    if (!codes.length) return;
    const pending = [];
    codes.forEach(code => {
      if (code.dataset.hl) return;                 // already processed
      const pre = code.parentElement;
      const m = /\blang-([A-Za-z0-9_+-]+)/.exec(pre.className || '');
      const lang = (m ? m[1] : '').toLowerCase();
      if (_HL_SKIP.has(lang)) { code.dataset.hl = 'skip'; return; }
      pending.push({ code, lang });
    });
    if (!pending.length) return;
    const run = () => {
      const hl = window.hljs;
      if (!hl) return;
      for (const { code, lang } of pending) {
        if (code.dataset.hl) continue;
        code.dataset.hl = '1';
        try {
          code.className = (hl.getLanguage && hl.getLanguage(lang))
            ? 'hljs language-' + lang
            : 'hljs';                              // unknown lang → auto-detect
          hl.highlightElement(code);
        } catch { /* leave plain on failure */ }
      }
    };
    if (window.hljs) run();
    else loadVendorScript('highlight.min.js').then(run).catch(() => {});
  }

  /**
   * Extract non-image file paths (.docx, .pdf, .zip, .csv, .xlsx, .json, ...) from
   * tool_result text and render an attachment card per file. The file extension
   * picks an icon. Clicking ⬇ Download fires file.saveAs RPC just like images.
   */
  const FILE_EXT_RE = /\.(docx?|pptx?|pdf|xlsx?|tsv|csv|json|zip|tar|gz|tgz|7z|rar|md|txt|log|html?|xml|yml|yaml|ini|toml|env|py|js|ts|tsx|jsx|c|cpp|h|hpp|go|rs|java|sh|bat|ps1|sql|wav|mp3|mp4|avi|mov|webm)$/i;
  const FILE_ICONS = {
    docx: '📄', doc: '📄', pptx: '📙', ppt: '📙', pdf: '📕', xlsx: '📊', xls: '📊', csv: '📊', tsv: '📊',
    json: '📋', xml: '📋', yml: '📋', yaml: '📋', ini: '📋', toml: '📋', env: '📋', log: '📋', sql: '📋',
    zip: '🗜️', tar: '🗜️', gz: '🗜️', tgz: '🗜️', '7z': '🗜️', rar: '🗜️',
    md: '📝', txt: '📝', html: '🌐', htm: '🌐',
    py: '🐍', js: '📜', ts: '📜', tsx: '📜', jsx: '📜',
    c: '⚙️', cpp: '⚙️', h: '⚙️', hpp: '⚙️', go: '⚙️', rs: '⚙️', java: '⚙️',
    sh: '🔧', bat: '🔧', ps1: '🔧',
    wav: '🎵', mp3: '🎵', mp4: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
  };
  /** Extensions we know how to display in the artifact panel iframe.
   *  Office formats (docx/xlsx/pptx) are extracted via the host (file.preview)
   *  into HTML; plain text formats are shown verbatim. */
  // 0.4.133 — extended for professional client-side render (docx-preview,
  // SheetJS, PptxViewJS, pdfjs, epub.js, DOMPurify, papaparse, json-formatter,
  // highlight.js). Legacy binary formats still route through backend's
  // OfficePreview text extractor.
  const PREVIEWABLE_EXT = new Set([
    'txt','md','markdown','json','csv','tsv','log','xml','yaml','yml','ini','toml','cfg','conf','env',
    'py','js','ts','tsx','jsx','c','cpp','h','hpp','sh','bash','sql','rs','go','java','rb','css','scss',
    'docx','xlsx','pptx','xls',                // modern + xls (SheetJS reads xls too)
    'doc','ppt','odt','rtf',                   // legacy binary → OfficePreview fallback
    'pdf', 'epub',
    'html','htm','svg',
  ]);

  /**
   * After the DOM is appended, fetch each image-card's bytes through host RPC
   * and stamp them onto the <img>. Idempotent — already-loaded cards skip.
   */
  function hydrateImageCards(rootEl) {
    const cards = (rootEl || document).querySelectorAll('.blk-image-card[data-img-path]:not([data-loaded])');
    cards.forEach(card => {
      const p = card.getAttribute('data-img-path');
      const img = card.querySelector('img');
      if (!p || !img) return;
      card.setAttribute('data-loaded', '1');
      if (/^https?:\/\//i.test(p)) {
        if (!img.getAttribute('src')) img.src = p;
        return;
      }
      // v0.4.251 — if the card was regex-guessed (data-verify) and the
      // host says the file is missing, remove the card silently instead
      // of showing "could not load: ENOENT". A real file (from image.attach
      // broadcast) never has data-verify.
      const isGuessed = card.getAttribute('data-verify') === '1';
      rpc('file.readAsDataUri', { path: p }).then(r => {
        if (r && r.dataUri) {
          img.src = r.dataUri;
          card.removeAttribute('data-verify');
        } else if (r && r.error) {
          if (isGuessed) { card.remove(); return; }
          img.alt = `(could not load: ${r.error})`;
          img.classList.add('err');
        }
      }).catch(err => {
        if (isGuessed) { card.remove(); return; }
        img.alt = `(load failed: ${err.message})`;
        img.classList.add('err');
      });
    });
    hydrateSpawnToolArtifactCards(rootEl || document);
  }

  /**
   * Friendly label for a tool_use call. Shows the most informative argument
   * inline so the user doesn't have to expand a JSON pre to see "what's running".
   * Examples:
   *   bash                       → 🖥️ bash · ls -la
   *   write_file                 → 📝 write_file · draw_cat.py
   *   renesas_generate_image     → 🎨 generating image · "cute cat ..."
   */
  // 0.4.129 — icons dropped for a cleaner, Claude-native look. Tool
  // identity now comes from the pretty name + headline only.
  const TOOL_ICONS = {};
  function toolHeadline(name, input) {
    const inp = input || {};
    if (name === 'bash')                   return inp.cmd || inp.command || '';
    if (name === 'python') {
      // Show first non-import line as headline so it's recognizable.
      const code = String(inp.code || inp.script || '');
      const firstSig = code.split('\n').find(l => l.trim() && !/^\s*(#|import |from )/.test(l)) || code.split('\n')[0] || '';
      return truncate(firstSig.trim(), 60);
    }
    if (name === 'write_file')             return inp.path || '';
    if (name === 'edit_file')              return inp.path || '';
    if (name === 'read_file')              return inp.path || '';
    if (name === 'renesas_generate_image') return truncate(inp.prompt || '', 60);
    if (/search/.test(name))               return truncate(inp.query || '', 60);
    if (/extract|scrape/.test(name))       return inp.url || '';
    return '';
  }
  function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function renderToolUse(b) {
    const name  = b.name || 'tool';
    // 0.4.129 — icons removed; label carries the identity.
    const headline = toolHeadline(name, b.input);
    const input = JSON.stringify(b.input ?? {}, null, 2);
    let empty = !input || input === '{}' || input === '{\n}';
    // 0.4.146 — while streaming, blk.input is still {} until
    // content_block_stop parses the buffered JSON. Show the partial raw
    // JSON so users can see the tool arguments forming in real time
    // instead of "(no input)" for the whole run.
    let streamingRaw = '';
    if (empty && typeof b._raw === 'string' && b._raw.length > 0) {
      streamingRaw = b._raw;
      empty = false;
    }
    // v0.4.14 — always stamp data-tool-id when we know it so replays from
    // JSONL can pair tool_result turns back to the bubble that emitted the
    // tool_use (findParentAssistantBubble). Streaming sets this via
    // onToolStart too; the static markup must carry it on its own.
    const idAttr = b.id ? ` data-tool-id="${escapeAttr(String(b.id))}"` : '';
    // 0.4.240 — stamp raw tool name so post-render passes can identify
    // svg_review runs (Plan B timeline card) without string-matching the
    // pretty-printed summary.
    const nameAttr = ` data-tool-name="${escapeAttr(String(name))}"`;
    const summaryHtml = `<b>${escapeHtml(prettyToolName(name))}</b>${headline ? `<span class="tool-headline">${escapeHtml(headline)}</span>` : ''}`;
    // 0.4.132 — empty input still renders as <details> so the user can
    // expand it (screenshot #54: an empty-input tool_use paired with a
    // tool error was un-expandable, hiding why the call failed).
    const body = empty ? '(no input)' : escapeHtml(streamingRaw || input);
    return `<details class="blk-tool-use"${idAttr}${nameAttr}><summary>${summaryHtml}</summary><pre>${body}</pre></details>`;
  }
  function prettyToolName(n) {
    return String(n)
      .replace(/^renesas_/, '')
      .replace(/_/g, ' ');
  }

  function renderMermaidLite(src) {
    const code = String(src || '').trim();
    const head = /^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i.exec(code);
    if (!head) return '';
    const dir = (head[1] || 'TD').toUpperCase();
    const labels = new Map();
    const edges = [];
    const groups = [];
    const nodeGroup = new Map();
    let curGroup = null;
    const addNode = (id, label) => {
      id = String(id || '').trim();
      if (!id) return;
      labels.set(id, String(label || labels.get(id) || id).replace(/^['"]|['"]$/g, ''));
      if (curGroup && !nodeGroup.has(id)) nodeGroup.set(id, curGroup.id);
    };
    const parseRef = (raw) => {
      raw = String(raw || '').trim().replace(/;$/, '');
      const m = /^([A-Za-z0-9_:-]+)\s*(?:\["?([\s\S]*?)"?\]|\{"?([\s\S]*?)"?\}|\("?([\s\S]*?)"?\))?$/.exec(raw);
      if (!m) return null;
      const id = m[1];
      addNode(id, m[2] || m[3] || m[4] || id);
      return id;
    };
    for (const rawLine of code.split(/\n+/)) {
      let line = rawLine.trim();
      if (!line) continue;
      line = line.replace(/%%.*$/, '').trim();
      if (!line || /^(?:graph|flowchart)\b/i.test(line)) continue;
      const gm = /^subgraph\s+([^\s\[]+)?\s*(?:\["?([\s\S]*?)"?\]|\("?([\s\S]*?)"?\)|"?([\s\S]*?)"?)?$/i.exec(line);
      if (gm) {
        curGroup = { id: gm[1] || `g${groups.length + 1}`, label: gm[2] || gm[3] || gm[4] || gm[1] || `Group ${groups.length + 1}` };
        groups.push(curGroup);
        continue;
      }
      if (/^end$/i.test(line)) { curGroup = null; continue; }
      const em = line.match(/^(.+?)\s*(?:--(?:[^-<>]+)?-->|-->|==>|-.->)\s*(.+)$/);
      if (em) {
        const left = em[1].split(/\s*&\s*/).map(parseRef).filter(Boolean);
        const right = em[2].split(/\s*&\s*/).map(parseRef).filter(Boolean);
        left.forEach(a => right.forEach(b => edges.push([a, b])));
      } else {
        parseRef(line);
      }
    }
    const ids = [...labels.keys()];
    if (!ids.length) return '';
    const horizontal = dir === 'LR' || dir === 'RL';
    const boxW = 250, boxH = 74, gapX = 90, gapY = 92, pad = 42;
    const pos = new Map();
    let rows;
    if (groups.length && !horizontal) {
      const seen = new Set();
      rows = groups.map(g => ids.filter(id => nodeGroup.get(id) === g.id));
      rows.forEach(r => r.forEach(id => seen.add(id)));
      const loose = ids.filter(id => !seen.has(id));
      if (loose.length) rows.unshift(loose);
    } else {
      const incoming = new Map(ids.map(id => [id, 0]));
      edges.forEach(([, b]) => incoming.set(b, (incoming.get(b) || 0) + 1));
      const level = new Map(ids.map(id => [id, 0]));
      for (let pass = 0; pass < ids.length; pass++) {
        let changed = false;
        edges.forEach(([a, b]) => {
          const next = (level.get(a) || 0) + 1;
          if (next > (level.get(b) || 0)) { level.set(b, next); changed = true; }
        });
        if (!changed) break;
      }
      const buckets = new Map();
      ids.forEach(id => {
        const l = incoming.get(id) ? (level.get(id) || 0) : 0;
        if (!buckets.has(l)) buckets.set(l, []);
        buckets.get(l).push(id);
      });
      rows = [...buckets.keys()].sort((a, b) => a - b).map(k => buckets.get(k));
    }
    const maxCols = Math.max(...rows.map(r => Math.max(1, r.length)));
    const w = horizontal ? pad * 2 + rows.length * boxW + (rows.length - 1) * gapX : pad * 2 + maxCols * boxW + (maxCols - 1) * gapX;
    const h = horizontal ? pad * 2 + maxCols * boxH + (maxCols - 1) * gapY : pad * 2 + rows.length * boxH + (rows.length - 1) * gapY;
    rows.forEach((row, ri) => {
      const rowW = row.length * boxW + Math.max(0, row.length - 1) * gapX;
      const startX = horizontal ? pad + ri * (boxW + gapX) : pad + Math.max(0, (w - pad * 2 - rowW) / 2);
      row.forEach((id, ci) => {
        const x = horizontal ? startX : startX + ci * (boxW + gapX);
        const y = horizontal ? pad + ci * (boxH + gapY) : pad + ri * (boxH + gapY);
        pos.set(id, { x, y });
      });
    });
    const esc = escapeHtml;
    const lines = [];
    lines.push(`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Mermaid flowchart" xmlns="http://www.w3.org/2000/svg">`);
    lines.push('<defs><marker id="marr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e"/></marker></defs>');
    for (const g of groups) {
      const members = ids.filter(id => nodeGroup.get(id) === g.id).map(id => pos.get(id)).filter(Boolean);
      if (!members.length) continue;
      const minX = Math.max(4, Math.min(...members.map(p => p.x)) - 16);
      const minY = Math.max(4, Math.min(...members.map(p => p.y)) - 24);
      const maxX = Math.max(...members.map(p => p.x + boxW)) + 16;
      const maxY = Math.max(...members.map(p => p.y + boxH)) + 14;
      lines.push(`<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="14" fill="#0f172a" fill-opacity=".45" stroke="#475569" stroke-opacity=".65" stroke-dasharray="5 5"/>`);
      lines.push(`<text x="${minX + 12}" y="${minY + 17}" fill="#93c5fd" font-size="11" font-family="Inter,system-ui,sans-serif">${esc(g.label)}</text>`);
    }
    edges.forEach(([a, b], ei) => {
      const pa = pos.get(a), pb = pos.get(b); if (!pa || !pb) return;
      const x1 = horizontal ? pa.x + boxW : pa.x + boxW / 2;
      const y1 = horizontal ? pa.y + boxH / 2 : pa.y + boxH;
      const x2 = horizontal ? pb.x : pb.x + boxW / 2;
      const y2 = horizontal ? pb.y + boxH / 2 : pb.y;
      const jitter = ((ei % 7) - 3) * 5;
      const c1x = horizontal ? x1 + 42 : x1 + jitter;
      const c1y = horizontal ? y1 + jitter : y1 + 30;
      const c2x = horizontal ? x2 - 42 : x2 - jitter;
      const c2y = horizontal ? y2 - jitter : y2 - 30;
      lines.push(`<path d="M${x1} ${y1} C${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}" fill="none" stroke="#9ca3af" stroke-opacity=".72" stroke-width="1.4" marker-end="url(#marr)"/>`);
    });
    ids.forEach(id => {
      const p = pos.get(id); if (!p) return;
      const label = esc(labels.get(id) || id).replace(/\\n/g, '\n');
      const chunks = label.split(/\n/).flatMap(part => part.match(/.{1,28}(?:\s|$)|\S+/g) || [part]).slice(0, 3);
      lines.push(`<rect x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="10" fill="#1f2937" stroke="#3b82f6" stroke-opacity=".65"/>`);
      chunks.forEach((t, i) => lines.push(`<text x="${p.x + boxW / 2}" y="${p.y + 22 + i * 15}" text-anchor="middle" fill="#e5e7eb" font-size="12" font-family="Inter,system-ui,sans-serif">${t.trim()}</text>`));
    });
    lines.push('</svg>');
    return lines.join('');
  }

  /**
   * Choose <summary> for a tool_result block.
   *   - If body is empty / just "{}" → "(no output)" (collapsed).
   *   - If image-card already on screen → "image generated" (collapsed).
   *   - Else → "tool result" with byte-count (auto-open).
   */
  function summarizeToolResult(body, isError, hasImageCard) {
    // 0.4.129 — icons dropped for a cleaner, Claude-native look.
    if (hasImageCard) return { icon: '', label: 'image generated' };
    if (isError)      return { icon: '', label: 'tool error' };
    const trimmed = String(body || '').trim();
    if (!trimmed || trimmed === '{}') return { icon: '', label: 'no output' };
    const lines = trimmed.split(/\n/).length;
    return { icon: '', label: `tool result · ${lines} line${lines === 1 ? '' : 's'}` };
  }

  /* ── Markdown renderer ──────────────────────────────────────────────
   * Hand-rolled (no external deps in WebView). Supports:
   *   • # H1 .. ###### H6
   *   • Fenced code ``` with optional lang tag
   *   • Inline code, **bold**, *italic*, ~~strike~~
   *   • Unordered (- / *) and ordered (1.) lists, single-level
   *   • GitHub-style tables: | a | b |
   *                          |---|---|
   *                          | 1 | 2 |
   *   • Block quotes (>)
   *   • Horizontal rule (--- on its own line)
   *   • Image syntax (file://abs or /abs path) → image-card
   *   • Plain links [text](url)
   *   • Paragraph splitting on blank lines
   * Order of operations matters: protect code fences first so their bodies
   * don't get mangled by the rest of the inline rules.
   */
  function renderMarkdown(src) {
    if (!src) return '';
    // 1a. Hide a TRAILING UNCLOSED fence — we're mid-stream, the closing
    // ``` hasn't arrived yet. Mermaid / SVG / HTML source would bleed into
    // the chat as raw text. Use a sentinel that survives the markdown
    // pipeline (NUL-delimited like our fence tokens) and only gets
    // restored to real HTML at the very end. Embedding a literal
    // `<div class="…">` here used to leak as text when the fence sat
    // inside <details>/<table>/<blockquote> contexts that escape HTML.
    // 0.4.37 — handle a trailing UNCLOSED ``` fence in two modes:
    //   • streaming (mid-flush)  → "Rendering X…" spinner card
    //   • settled  (replay/done) → "Truncated source" details (model
    //                              ended before closing the fence — used
    //                              to dump raw <svg ...> text into chat,
    //                              looking like a render bug).
    let streamingFenceMarker = null;
    let truncatedFenceLang = null;
    let truncatedFenceBody = '';
    {
      // 0.4.45 — count ``` to decide if the LAST opener is unclosed.
      // Earlier regex matched the FIRST `\`\`\`` after which no closer
      // appears, but model output like
      //   "Here's the diagram:\n\n```svg\n<svg ...></svg>\n```\n\n```svg<svg ..."
      // (two SVGs back-to-back, second one mid-stream) wasn't handled:
      // the regex captured everything from the first ``` to EOF and
      // saw a ``` inside → bailed → second SVG dumped as raw text.
      const fenceMatches = [...src.matchAll(/```([A-Za-z0-9_+-]+)?[ \t]*\n?/g)];
      if (fenceMatches.length % 2 === 1) {
        const last = fenceMatches[fenceMatches.length - 1];
        const lang = (last[1] || '').toLowerCase();
        const bodyStart = last.index + last[0].length;
        if (renderMarkdown._streamingNow) {
          streamingFenceMarker = lang === 'mermaid'    ? 'diagram'
                               : lang === 'html'       ? 'HTML'
                               : lang === 'svg'        ? 'SVG'
                               : (lang || 'code');
          src = src.slice(0, last.index) + `\n\x00STREAMFENCE\x00\n`;
        } else {
          // Truncated turn — stash body, replace with a clean sentinel.
          truncatedFenceLang = lang || 'code';
          truncatedFenceBody = src.slice(bodyStart);
          src = src.slice(0, last.index) + `\n\x00TRUNCFENCE\x00\n`;
        }
      }
    }
    // 1. Stash fenced code so we don't escape it inside the per-line passes.
    const fences = [];
    let raw = src.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, body) => {
      fences.push({ lang: lang || '', body });
      return ` FENCE${fences.length - 1} `;
    });

    // Protect inline-code spans before math: `$PATH` and `$HOME` are code, not
    // a single math expression spanning the words between them.
    const inlineCodes = [];
    raw = raw.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return `\x00ICODE${inlineCodes.length - 1}\x00`;
    });

    // Stash TeX before inline markdown so `_`, `*`, and backticks inside a
    // formula are not interpreted as emphasis/code. Fences were stashed first,
    // therefore currency/code examples inside fenced blocks remain untouched.
    const maths = [];
    const stashMath = (full, tex, display) => {
      maths.push({ tex, display });
      return `\x00MATH${maths.length - 1}\x00`;
    };
    raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => stashMath(m, tex, true));
    raw = raw.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => stashMath(m, tex, true));
    raw = raw.replace(/\\\(([^\n]+?)\\\)/g, (m, tex) => stashMath(m, tex, false));
    raw = raw.replace(/(^|[^\\$])\$([^\s$][^\n$]*?[^\s$]|[^\s$])\$(?!\d)/g,
      (m, prefix, tex) => `${prefix}${stashMath(m, tex, false)}`);

    // 2. Stash images first (they include parens/brackets that confuse links).
    const imgs = [];
    // v0.4.254 — skip container-internal paths (/tmp/aura-artifacts/...).
    // Host cannot read them; the real card comes from backend's image.attach
    // broadcast pointing at <dataRoot>/chat-images/<chatId>/.
    raw = raw.replace(
      /!\[([^\]]*)\]\((file:\/\/)?((?:\/|[a-zA-Z]:[\\/])[^\s)]+\.(?:png|jpe?g|webp|gif|svg))\)/gi,
      (_, alt, _proto, p) => {
        if (/\/(?:tmp\/aura-artifacts|chat-images|chat-artifacts)\//.test(p)) return '';
        imgs.push({ alt, path: p });
        return ` IMG${imgs.length - 1} `;
      });
    raw = raw.replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+(?:png|jpe?g|webp|gif|svg)(?:\?[^\s)]*)?)\)/gi,
      (_, alt, url) => {
        if (/\/api\/images\//.test(url)) return '';
        imgs.push({ alt, path: url });
        return ` IMG${imgs.length - 1} `;
      });
    // Relative image markdown from sandbox/sub-agent text (e.g. ![](dog.png))
    // is not webview-addressable. The durable artifact pipeline renders the
    // actual promoted file card; suppress the broken browser-relative <img>.
    raw = raw.replace(/!\[[^\]]*\]\((?!https?:\/\/|file:\/\/|\/|[A-Za-z]:[\\/])[^\s)]+\.(?:png|jpe?g|webp|gif|svg)(?:\?[^\s)]*)?\)/gi, '');

    // 2.5. Headings can appear anywhere — line-by-line. Split out any line that
    //      starts with #+ space into its own block so they always render as <h*>
    //      even when followed immediately by list/table without a blank line.
    raw = raw.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => `\n\n${hashes} ${content}\n\n`);

    // 3. Split into block-level chunks separated by blank lines.
    const blocks = raw.split(/\n{2,}/);
    const out = [];
    for (const blk of blocks) {
      const t = blk.replace(/\s+$/, '');
      if (!t.length) continue;
      // Headings — match a whole-line heading even if other text was joined.
      const h = t.match(/^(#{1,6})\s+(.+)$/);
      if (h && !t.includes('\n')) { out.push(`<h${h[1].length} class="md-h md-h${h[1].length}">${inline(h[2])}</h${h[1].length}>`); continue; }
      // Horizontal rule
      if (/^-{3,}$/m.test(t) && !t.includes('|')) { out.push('<hr class="md-hr">'); continue; }
      // Table — first line has |, second is divider --- with optional :
      if (looksLikeTable(t)) { out.push(renderTable(t)); continue; }
      // Block quote — every line begins with >. Strip the quote marker, then
      // render inline markdown inside the quote body so **bold** / links / code
      // survive even when the portal renderer nests the quote in another block.
      if (t.split('\n').every(l => /^>\s?/.test(l))) {
        const inner = t.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n');
          const quoteHtml = renderMarkdown(inner);
        out.push(`<blockquote class="md-bq">${quoteHtml.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')}</blockquote>`);
        continue;
      }
      // Lists
      if (/^[-*]\s+/.test(t.split('\n')[0])) {
        const items = t.split(/\n(?=[-*]\s+)/).map(l => l.replace(/^[-*]\s+/, ''));
        out.push(`<ul class="md-ul">${items.map(i => `<li>${inline(i.replace(/\n/g, ' '))}</li>`).join('')}</ul>`);
        continue;
      }
      if (/^\d+\.\s+/.test(t.split('\n')[0])) {
        const items = t.split(/\n(?=\d+\.\s+)/).map(l => l.replace(/^\d+\.\s+/, ''));
        out.push(`<ol class="md-ol">${items.map(i => `<li>${inline(i.replace(/\n/g, ' '))}</li>`).join('')}</ol>`);
        continue;
      }
      // Paragraph (single \n becomes <br>)
      out.push(`<p>${inline(t).replace(/\n/g, '<br>')}</p>`);
    }
    let html = out.join('');

    // 4. Restore fences (escape body now).
    html = html.replace(/ FENCE(\d+) /g, (_, i) => {
      const f = fences[+i];
      const lang = (f.lang || '').toLowerCase();
      const fenceBody = String(f.body || '').trim();
      // 0.4.34 — ```svg blocks render inline as a real <svg>, the same
      // way Claude.ai does. SVG is plain markup so we just inject it
      // verbatim into a card; the raw source is hidden behind a "view
      // source" details so the diagram is the primary content. Clicking
      // the SVG opens it in the lightbox (via the existing .blk-image-card
      // click handler). Also recover historical fences where the model pasted
      // raw SVG under a plain ``` code block without the `svg` language tag.
      if (lang === 'svg' || /^<svg[\s>]/i.test(fenceBody)) {
        let body = fenceBody;
        // 0.4.42 — strip width="…" and height="…" from the root <svg>
        // so CSS `width:100%; height:auto` wins.
        body = body.replace(/^<svg\b[^>]*>/i, (open) =>
          open.replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, ''),
        );
        // 0.4.48 — also strip any inline `style="background:..."` from
        // the root <svg>, and remove the very common "full-area white
        // background rect" the model paints as the first child. Both
        // turn the diagram into a white square that hides text on light
        // colours — what user reported repeatedly.
        body = body.replace(/^<svg\b[^>]*>/i, (open) =>
          open.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, ''),
        );
        // 0.4.50 — strip the "page background" rect the model often
        // paints as the first element. Catches:
        //   <rect width="100%" height="100%" fill="white"/>
        //   <rect x="0" y="0" width="680" height="900" fill="#f8fafc"/>
        //   <rect ... fill="#ffffff"/>
        // i.e. any rect at origin that's the size of the viewBox or
        // covers 100% and uses a near-white fill. We never want a
        // light page background on the dark chat theme — it makes
        // saturated text on coloured rects unreadable.
        const NEAR_WHITE = /^["'](?:white|#f[a-f0-9]{2,7})/i;
        body = body.replace(
          /(<svg\b[^>]*>\s*(?:<defs>[\s\S]*?<\/defs>\s*)?)<rect\b([^>]*)\/?>(?:\s*<\/rect>)?/i,
          (m, prefix, attrs) => {
            const fillM = /\bfill\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs);
            const widthM = /\bwidth\s*=\s*("[^"]*"|'[^']*')/i.exec(attrs);
            if (!fillM) return m;
            const isLight = NEAR_WHITE.test(fillM[1]);
            if (!isLight) return m;
            // Looks like a page background if width is 100% OR the rect
            // has no x/y (defaults to 0,0) and width is set.
            const looksFull = widthM && (/100%/.test(widthM[1]) || !/\bx\s*=/.test(attrs));
            return looksFull ? prefix : m;
          },
        );
        if (/^<svg[\s>]/i.test(body)) {
          // 0.4.59 — lightbox now clones the inline SVG directly (no <img>
          // data URL), so we no longer need to base64-encode body here. We
          // still keep `data-img-path` as a fallback for the download path.
          const b64 = (() => {
            try {
              return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(body)));
            } catch { return 'data:image/svg+xml;utf8,' + encodeURIComponent(body); }
          })();
          return `<figure class="blk-svg-card blk-image-card" data-img-path="${escapeAttr(b64)}">
            <button class="blk-svg-zoom" data-act="zoomSvg" title="Zoom" aria-label="Zoom SVG">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            </button>
            <div class="blk-svg-stage">${body}</div>
            <details class="md-svg-src"><summary>view source</summary>
              <pre class="md-code lang-svg"><code>${escapeHtml(f.body)}</code></pre>
            </details>
          </figure>`;
        }
      }
      // ```mermaid blocks render INLINE as a sandboxed iframe — Anthropic
      // Console / Claude.ai do the same. (#8 in 0.4.1)
      if (lang === 'mermaid') {
        const code = f.body;
        const lite = renderMermaidLite(code);
        if (lite) {
          return `<div class="md-mermaid md-mermaid-lite">
            <div class="md-mermaid-toolbar">
              <button class="artifact-zoom-btn" data-act="mermaidZoomOut" title="Zoom out">−</button>
              <span class="artifact-zoom-pct" data-mermaid-pct>100%</span>
              <button class="artifact-zoom-btn" data-act="mermaidZoomIn" title="Zoom in">+</button>
              <button class="artifact-zoom-btn" data-act="mermaidZoomReset" title="Reset zoom">100%</button>
              <button class="blk-svg-zoom" data-act="zoomMermaid" title="Open chart zoom" aria-label="Open chart zoom">Open</button>
            </div>
            <div class="md-mermaid-stage"><div class="md-mermaid-canvas">${lite}</div></div>
            <details class="md-mermaid-src"><summary>view source</summary>
              <pre class="md-code lang-mermaid"><code>${escapeHtml(code)}</code></pre>
            </details>
          </div>`;
        }
        return `<pre class="md-code lang-mermaid"><code>${escapeHtml(code)}</code></pre>`;
      }
      return `<pre class="md-code${f.lang ? ` lang-${escapeHtml(f.lang)}` : ''}"><code>${escapeHtml(f.body)}</code></pre>`;
    });

    // 4b. 0.4.35 — restore the streaming-fence sentinel as a real card.
    // We do this AFTER markdown is fully assembled so the marker survives
    // escaping rules. Embedding a literal `<div class="…">` here used to
    // leak as raw text (the symptom user reported).
    if (streamingFenceMarker) {
      const card = `<div class="md-streaming-fence"><span class="md-streaming-spinner"></span><span>Rendering ${escapeHtml(streamingFenceMarker)}…</span></div>`;
      html = html.split('\x00STREAMFENCE\x00').join(card);
    }
    // 0.4.37 — settled bubble with an unclosed fence: render a clean
    // truncation card instead of dumping raw <svg ...> text into the
    // chat (the symptom user reported — wall of <rect><text> markup
    // sitting under the bubble because the model never sent the ```).
    if (truncatedFenceLang !== null) {
      const truncCard = `<div class="md-trunc-fence">
        <span>⚠ Output was cut off before the <code>${escapeHtml(truncatedFenceLang)}</code> block finished.</span>
        <details class="md-trunc-fence-src"><summary>view partial source</summary>
          <pre class="md-code lang-${escapeHtml(truncatedFenceLang)}"><code>${escapeHtml(truncatedFenceBody)}</code></pre>
        </details>
      </div>`;
      html = html.split('\x00TRUNCFENCE\x00').join(truncCard);
    }
    html = html.replace(/\x00ICODE(\d+)\x00/g, (_, i) =>
      `<code class="md-icode">${escapeHtml(inlineCodes[+i] || '')}</code>`);

    // Restore locally-rendered KaTeX. throwOnError=false preserves malformed
    // formula source without breaking the rest of the message.
    html = html.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
      const math = maths[+i];
      if (!math) return '';
      try {
        if (window.katex?.renderToString) {
          return window.katex.renderToString(math.tex, {
            displayMode: math.display, throwOnError: false, output: 'html',
          });
        }
      } catch { /* escaped fallback below */ }
      const cls = math.display ? 'md-math-fallback display' : 'md-math-fallback';
      return `<code class="${cls}">${escapeHtml(math.tex)}</code>`;
    });

    // 5. Restore image cards.
    html = html.replace(/ IMG(\d+) /g, (_, i) => {
      const im = imgs[+i];
      const filename = im.path.split(/[\\/]/).pop().split('?')[0] || im.alt || 'image';
      const isHttp = /^https?:\/\//i.test(im.path);
      return `<figure class="blk-image-card" data-img-path="${escapeAttr(im.path)}">
        <img ${isHttp ? `src="${escapeAttr(im.path)}"` : ''} alt="${escapeHtml(im.alt || filename)}" />
        <figcaption>
          <span class="img-name" title="${escapeAttr(im.path)}">${escapeHtml(filename)}</span>
          <button class="img-dl" data-act="downloadImage" data-img-path="${escapeAttr(im.path)}" title="Save image…">⬇ Download</button>
        </figcaption>
      </figure>`;
    });

    return html;
  }
  /** Inline markdown: code, bold/italic, strike, links — also escapes HTML. */
  function inline(s) {
    let h = escapeHtml(s);
    h = h.replace(/`([^`\n]+)`/g, '<code class="md-icode">$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    h = h.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    // links: [text](url) — url may include ( ) inside? keep simple, no nesting
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return h;
  }
  function looksLikeTable(t) {
    const lines = t.split('\n');
    if (lines.length < 2) return false;
    if (!lines[0].includes('|')) return false;
    return /^\s*\|?\s*:?-{3,}/.test(lines[1]) || /\|\s*:?-{3,}/.test(lines[1]);
  }
  function renderTable(t) {
    const lines = t.split('\n').filter(l => l.trim().length);
    const splitRow = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
    const head = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map(c => {
      const left = c.startsWith(':'), right = c.endsWith(':');
      if (left && right) return 'center';
      if (right)         return 'right';
      return 'left';
    });
    const body = lines.slice(2).map(splitRow);
    const th = head.map((c, i) => `<th style="text-align:${aligns[i] || 'left'}">${inline(c)}</th>`).join('');
    const tr = body.map(row =>
      `<tr>${row.map((c, i) => `<td style="text-align:${aligns[i] || 'left'}">${inline(c)}</td>`).join('')}</tr>`
    ).join('');
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  /* Auto-follow mode: when user scrolls up during a stream we PAUSE
     auto-scroll so they can read older content. Ctrl+End (or scrolling back
     to within ~80px of the bottom) re-arms follow.

     Why: branch aura_v1_pre_studio_port had this and it was removed in the
     v2 port; user explicitly asked for it back (#18).                    */

  /** 0.4.93 — inject cached artifact cards into the freshly-rendered
   *  thread. Called from loadChat AFTER all turns are in DOM. Cards are
   *  built synchronously (no broadcast round-trip), keyed by tool_use_id,
   *  so the docx-vanish race can't recur. Falls back to the last
   *  assistant bubble's strip for orphans (files whose filename wasn't
   *  found in any tool_result text). */
  function injectCachedArtifacts(chatId, cached) {
    const byTool = (cached && cached.byTool) || {};
    const orphans = [...((cached && cached.orphans) || [])];
    const scopedAgentId = cached && cached.agentId;
    // v0.4.262 — id-based aura_artifact records from history. Route through
    // onArtifactAttach so the render path is identical to SSE-live.
    const auraArtifacts = (cached && cached.auraArtifacts) || [];
    for (const a of auraArtifacts) rememberArtifact({ ...a, chatId });
    dbg(`injectCachedArtifacts chat=${chatId} active=${state.activeChatId} gen=${state.loadGen} aura=${auraArtifacts.length} bubbles=${els.threadInner.querySelectorAll('.msg-assistant').length}`);
    for (const a of auraArtifacts) {
      const entryAgentId = scopedAgentId || a.agentId || a.sourceAgentId || undefined;
      if (scopedAgentId && entryAgentId && entryAgentId !== scopedAgentId) continue;
      if (!scopedAgentId && entryAgentId && !hasRenderedAgentHandoff(entryAgentId)) continue;
      dbg(`  aura id=${a.id} mt=${a.mediaType} isVis=${a.isVisualise} tuid=${a.toolUseId} uri=${(a.webviewUri||'').slice(-40)} anchorInDom=${!!els.threadInner.querySelector(`.blk-tool-use[data-tool-id="${cssEscape(String(a.toolUseId))}"]`)}`);
      const payload = { ...a, chatId, ...(entryAgentId ? { agentId: entryAgentId } : {}) };
      onArtifactAttach(payload);
    }
    const tids = Object.keys(byTool);
    const foundAnchors = tids.filter(tid =>
      els.threadInner.querySelector(`.blk-tool-use[data-tool-id="${cssEscape(String(tid))}"]`)
    );
    console.log('[studio] injectCachedArtifacts', {
      chatId, tids: tids.length, orphans: orphans.length,
      anchorsInDom: foundAnchors.length,
      missing: tids.filter(t => !foundAnchors.includes(t)),
    });
    // Only persisted aura_artifact_pin records render inline. Do not replay generic
    // sandbox/spawn output files from cached byTool/orphan maps; those created
    // duplicate cards outside the artifact_pin result.
    for (const [tid, entries] of []) {
      const scopeRoot = scopedAgentId
        ? els.threadInner.querySelector(`.msg-assistant[data-agent-id="${cssEscape(String(scopedAgentId))}"]`)?.parentNode || els.threadInner
        : els.threadInner;
      let anchor = scopeRoot.querySelector(
        `.blk-tool-use[data-tool-id="${cssEscape(String(tid))}"]`
      );
      if (!anchor) {
        // 0.4.98 — fallback: attach to last assistant bubble's strip so
        // the card doesn't vanish just because tool_use for this file
        // wasn't in the JSONL (or wasn't rendered).
        console.warn('[studio] injectCachedArtifacts: no anchor for tid', tid, '— no matching tool_use in current view');
        if (!scopedAgentId) orphans.push(...entries);
        continue;
      }
      const bubble = anchor.closest('.msg-assistant');
      const body = bubble?.querySelector(':scope > .msg-body') || bubble;
      if (!body) continue;
      for (const e of entries) {
        // Dedup: skip if this artifact/output already exists in the current thread.
        const dedupKey = e.localPath + '::' + tid;
        if (bubble.querySelector(`[data-dedup-key="${cssEscape(dedupKey)}"]`) || artifactDomExists(e)) continue;
        // 0.4.112 — surfaceImages fires image.attach on reload BEFORE
        // chats.cachedArtifacts resolves; onImageAttach creates a
        // .msg-image-wrap that has NO data-dedup-key, so the querySelector
        // above misses it and we duplicate. Consult the same
        // state.attachedImageKeys set onImageAttach guards on.
        if (e.mediaType && e.mediaType.startsWith('image/') && !rememberImageAttach(e)) continue;
        const card = e.mediaType && e.mediaType.startsWith('image/')
          ? buildImageCardStatic(chatId, e, tid)
          : e.mediaType === 'text/html'
            ? buildHtmlCardStatic(chatId, e, tid)
            : buildFileCardStatic(chatId, e, tid);
        // Walk anchor up until parent is body, then insert AFTER the
        // matching tool_result (0.4.114 — was landing between tool_use
        // and tool_result on reload).
        let after = anchor;
        while (after.parentElement && after.parentElement !== body) after = after.parentElement;
        const matchesResult = (el) => {
          if (!el || !el.querySelector) return false;
          const sel = `.blk-tool-result[data-tool-use-id="${cssEscape(String(tid))}"]`;
          return el.matches?.(sel) || !!el.querySelector(sel);
        };
        const isEmptyStrip = (el) => el && el.classList && el.classList.contains('msg-artifact-strip') && !el.firstChild;
        while (after.nextSibling && (matchesResult(after.nextSibling) || isEmptyStrip(after.nextSibling))) {
          after = after.nextSibling;
        }
        after.parentNode.insertBefore(card, after.nextSibling);
      }
    }
    if (false && orphans.length) {
      const orphanScope = scopedAgentId
        ? els.threadInner.querySelector(`.msg-assistant[data-agent-id="${cssEscape(String(scopedAgentId))}"]`)?.parentNode || els.threadInner
        : els.threadInner;
      const lastBubble = scopedAgentId
        ? orphanScope.querySelector(`.msg-assistant[data-agent-id="${cssEscape(String(scopedAgentId))}"]:last-of-type`)
        : orphanScope.querySelector('.msg-assistant:last-of-type');
      const body = lastBubble?.querySelector(':scope > .msg-body') || lastBubble;
      if (body) {
        // 0.4.131 — orphans (no matching tool_use anchor) append inline to
        // body instead of routing through .msg-artifact-strip.
        for (const e of orphans) {
          const dedupKey = e.localPath + '::';
          if (body.querySelector(`[data-dedup-key="${cssEscape(dedupKey)}"]`) || artifactDomExists(e)) continue;
          if (e.mediaType && e.mediaType.startsWith('image/') && !rememberImageAttach(e)) continue;
          const card = e.mediaType && e.mediaType.startsWith('image/')
            ? buildImageCardStatic(chatId, e, '')
            : e.mediaType === 'text/html'
              ? buildHtmlCardStatic(chatId, e, '')
              : buildFileCardStatic(chatId, e, '');
          body.appendChild(card);
        }
      }
    }
    if (!document.body.classList.contains('has-artifact') && !state.activeAgentId) scrollThreadToEnd();
  }

  function insertCachedAgentArtifactFallback(chatId, agentId, payload) {
    const id = payload?.id;
    if (!id || els.threadInner.querySelector(`[data-artifact-id="${cssEscape(String(id))}"]`)) return;
    const turnId = payload?.turnId;
    let body = null;
    if (turnId !== undefined && turnId !== null) {
      const bubble = els.threadInner.querySelector(
        `.msg-assistant[data-agent-id="${cssEscape(String(agentId))}"][data-turn-id="${cssEscape(String(turnId))}"]`
      );
      body = bubble?.querySelector(':scope > .msg-body') || bubble || null;
    }
    if (!body && payload?.toolUseId) {
      const anchor = els.threadInner.querySelector(`.blk-tool-use[data-tool-id="${cssEscape(String(payload.toolUseId))}"]`);
      const bubble = anchor?.closest('.msg-assistant');
      body = bubble?.querySelector(':scope > .msg-body') || bubble || null;
    }
    if (!body) return;
    const mt = String(payload.mediaType || '');
    const card = mt.startsWith('image/')
      ? buildImageCardStatic(chatId, payload, payload.toolUseId || '')
      : mt === 'text/html'
        ? buildHtmlCardStatic(chatId, payload, payload.toolUseId || '')
        : buildFileCardStatic(chatId, payload, payload.toolUseId || '');
    body.appendChild(card);
  }

  function buildFileCardStatic(chatId, e, tid) {
    const { size, mediaType, localPath } = e;
    const filename = e.filename || e.name || (localPath ? localPath.split('/').pop() : '') || e.id || 'artifact';
    const agentId = e.agentId || e.sourceAgentId || state.activeAgentId || undefined;
    const card = document.createElement('div');
    card.className = 'msg-file-card';
    card.dataset.artifactId = e.id || e.artifactId || '';
    card.title = filename;
    card.dataset.dedupKey = (localPath || filename) + '::' + (tid || '');

    const icon = document.createElement('span');
    icon.className = 'mfc-ico';
    icon.textContent = pickFileIcon(filename, mediaType);

    const meta = document.createElement('div');
    meta.className = 'mfc-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'mfc-name';
    nameEl.textContent = filename;
    const sizeEl = document.createElement('div');
    sizeEl.className = 'mfc-sub muted small';
    sizeEl.textContent = formatBytes(size) + ' · ' + prettyFileType(filename, mediaType);
    meta.appendChild(nameEl);
    meta.appendChild(sizeEl);
    // v0.4.257 — show host storage path so user knows where the file lives.
    if (localPath) {
      const pathEl = document.createElement('div');
      pathEl.className = 'mfc-sub muted small mfc-path';
      pathEl.textContent = localPath;
      pathEl.title = localPath;
      meta.appendChild(pathEl);
    }

    const actions = document.createElement('div');
    actions.className = 'mfc-actions';
    const preview = document.createElement('button');
    preview.className = 'ghost-btn';
    preview.textContent = 'Preview';
    preview.onclick = async () => {
      const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
      if ((localPath || e.id) && PREVIEWABLE_EXT.has(ext)) {
        preview.disabled = true;
        preview.textContent = 'Loading…';
        try {
          const r = e.id ? await rpc('artifact.preview', { chatId: e.chatId || chatId || state.activeChatId, id: e.id, agentId }) : await rpc('file.preview', { path: localPath });
          if (r?.error) throw new Error(r.error);
          const artId = addArtifact({
            kind: r.kind || 'text',
            title: filename,
            source: r.source || r.html || r.text || '',
            path: r.path || localPath || filename,
            data: r.data, text: r.text, lang: r.lang, delimiter: r.delimiter, filename: r.filename || filename,
            artifactId: e.id, chatId: e.chatId || chatId || state.activeChatId, mediaType,
          });
          try { selectArtifact(artId); openArtifactPanel(); } catch {}
          return;
        } catch (err) {
          console.warn('[studio] preview failed:', err);
          showToast('Preview failed: ' + (err && err.message || err), 'error', 5000);
        }
        finally { preview.disabled = false; preview.textContent = 'Preview'; }
      }
    };
    const dl = document.createElement('button');
    dl.className = 'primary-btn';
    dl.textContent = 'Download';
    dl.onclick = async () => {
      dl.disabled = true;
      await saveAsDownload({ id: e.id, chatId: e.chatId || chatId || state.activeChatId, agentId, path: localPath });
      dl.disabled = false;
    };
    actions.appendChild(preview);
    actions.appendChild(dl);

    card.appendChild(icon);
    card.appendChild(meta);
    card.appendChild(actions);
    return card;
  }

  function buildHtmlCardStatic(chatId, e, tid) {
    const filename = e.filename || e.name || e.id || 'artifact.html';
    const agentId = e.agentId || e.sourceAgentId || state.activeAgentId || undefined;
    const wrap = document.createElement('figure');
    wrap.className = 'art-html-card';
    wrap.dataset.artifactId = e.id || e.artifactId || '';
    wrap.dataset.dedupKey = (e.localPath || filename) + '::' + (tid || '');
    wrap.title = filename;

    const header = document.createElement('div');
    header.className = 'art-html-header';
    const nameEl = document.createElement('div');
    nameEl.className = 'art-html-name';
    nameEl.textContent = filename;
    nameEl.title = filename;
    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'btn';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', async () => {
      try { await previewArtifactEntry({ ...e, chatId: e.chatId || chatId || state.activeChatId, id: e.id, localPath: e.localPath, name: filename, mediaType: 'text/html', agentId }); }
      catch (err) { showToast('Preview failed: ' + (err && err.message || err), 'error', 5000); }
    });
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn';
    saveBtn.textContent = 'Save As';
    saveBtn.addEventListener('click', () => saveAsDownload({ id: e.id, chatId: e.chatId || chatId || state.activeChatId, agentId, path: e.localPath || '' }));
    header.appendChild(nameEl);
    header.appendChild(previewBtn);
    header.appendChild(saveBtn);
    wrap.appendChild(header);

    if (e.localPath) {
      const pathRow = document.createElement('div');
      pathRow.className = 'art-html-paths';
      const pathEl = document.createElement('div');
      pathEl.className = 'art-html-path';
      pathEl.textContent = 'local: ' + e.localPath;
      pathEl.title = e.localPath;
      pathRow.appendChild(pathEl);
      wrap.appendChild(pathRow);
    }

    const holder = document.createElement('div');
    holder.className = 'art-html-render';
    holder.textContent = '⏳ loading html…';
    const loadHtml = (attempt) => {
      const req = e.id
        ? rpc('artifact.getText', { chatId: e.chatId || chatId || state.activeChatId, id: e.id, agentId })
        : rpc('file.preview', { path: e.localPath || '' }).then(r => ({ text: r?.source || r?.html || r?.text || '', error: r?.error }));
      req.then(r => {
        const html = String((r && r.text) || '');
        if (!html && attempt < 8) { setTimeout(() => loadHtml(attempt + 1), 300 * attempt); return; }
        if (!html) { holder.textContent = r?.error ? `HTML load failed: ${r.error}` : 'HTML load failed'; return; }
        renderVisualiseInline(html, holder);
      }).catch(err => {
        if (attempt < 8) setTimeout(() => loadHtml(attempt + 1), 300 * attempt);
        else holder.textContent = `HTML load failed: ${err && err.message ? err.message : err}`;
      });
    };
    loadHtml(1);
    wrap.appendChild(holder);
    return wrap;
  }

  function buildImageCardStatic(chatId, e, tid) {
    const { webviewUri, localPath } = e;
    const filename = e.filename || e.name || (localPath ? localPath.split('/').pop() : '') || e.id || 'image';
    const agentId = e.agentId || e.sourceAgentId || state.activeAgentId || undefined;
    const wrap = document.createElement('div');
    wrap.className = 'msg-image-wrap';
    wrap.dataset.artifactId = e.id || e.artifactId || '';
    wrap.title = filename;
    wrap.dataset.dedupKey = (localPath || filename) + '::' + (tid || '');
    stampImageAttachKeys(wrap, e);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'msg-image-card';
    card.title = 'Click to enlarge';
    const img = document.createElement('img');
    if (webviewUri) img.src = webviewUri;
    img.alt = filename || 'image';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    const loadImage = () => {
      if (e.id) {
        rpc('artifact.readAsDataUri', { chatId: e.chatId || chatId || state.activeChatId, id: e.id, agentId }).then(r => {
          if (r && r.dataUri) img.src = r.dataUri;
          else img.classList.add('err');
        }).catch(() => img.classList.add('err'));
      } else if (localPath && img.src !== localPath) {
        rpc('file.readAsDataUri', { path: localPath }).then(r => {
          if (r && r.dataUri) img.src = r.dataUri;
          else img.classList.add('err');
        }).catch(() => img.classList.add('err'));
      } else {
        img.classList.add('err');
      }
    };
    img.addEventListener('error', loadImage, { once: true });
    if (!webviewUri) loadImage();
    card.appendChild(img);
    card.addEventListener('click', (ev) => {
      if (ev.target.closest('.msg-image-dl')) return;
      ev.preventDefault();
      ev.stopPropagation();
      openImageLightbox(img.currentSrc || img.src || webviewUri || localPath, filename);
    });
    wrap.appendChild(card);

    const dlHost = document.createElement('button');
    dlHost.type = 'button';
    dlHost.className = 'msg-image-dl';
    dlHost.title = 'Save to the Linux host';
    dlHost.setAttribute('aria-label', 'Save to Linux host');
    dlHost.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
    dlHost.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      await saveAsDownload({ id: e.id, chatId: e.chatId || chatId || state.activeChatId, agentId, path: localPath });
    });
    wrap.appendChild(dlHost);
    return wrap;
  }

  const _scroll = { follow: true, threshold: 100 };
  function scrollThreadToEnd(force) {
    const t = $('#thread');
    if (!t) return;
    if (force) {
      _scroll.follow = true;
      const jb = t.querySelector('.jump-bottom-btn');
      if (jb) jb.hidden = true;
    }
    if (!_scroll.follow) return;
    t.scrollTop = t.scrollHeight;
  }
  function isThreadNearBottom() {
    const t = $('#thread');
    if (!t) return true;
    return (t.scrollHeight - t.scrollTop - t.clientHeight) <= _scroll.threshold;
  }
  function bindThreadScroll() {
    const t = $('#thread');
    if (!t || t.dataset.followBound) return;
    t.dataset.followBound = '1';

    // Sticky "Jump to latest ↓" button shown only when follow is OFF AND
    // user is meaningfully scrolled up. Click = re-arm + scroll.
    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'jump-bottom-btn';
    jumpBtn.title = 'Jump to latest (Ctrl+End)';
    jumpBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>';
    jumpBtn.hidden = true;
    jumpBtn.onclick = () => scrollThreadToEnd(true);
    t.appendChild(jumpBtn);

    const updateJump = () => {
      const distance = t.scrollHeight - t.scrollTop - t.clientHeight;
      _scroll.follow = distance <= _scroll.threshold;
      jumpBtn.hidden = _scroll.follow;
    };
    t.addEventListener('scroll', updateJump, { passive: true });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'End' && (e.ctrlKey || e.metaKey)) {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        scrollThreadToEnd(true);
        jumpBtn.hidden = true;
      }
    });
  }

  /* ── Streaming pipeline ─────────────────────────────────────────── */
  function onChatStart({ chatId, iter, sysTokens, historyTokens, toolTokens, runtimeTokens, contextTotal, contextMax, contextPct, proxy }) {
    updateProxyPill(proxy);
    state.streamingChats.add(chatId);
    // Refresh composer state — if user is currently viewing THIS chat we
    // flip Send→Stop; otherwise nothing changes for them.
    if (chatId === state.activeChatId) {
      refreshComposerButtons();
      const seed = {};
      if (typeof sysTokens === 'number')     seed.sys   = sysTokens;
      if (typeof historyTokens === 'number') seed.hist  = historyTokens;
      if (typeof toolTokens === 'number')    seed.tools = toolTokens;
      // ledgerIn shows the authoritative API total for this turn — leave
      // it alone here so it doesn't flash a pre-flight estimate that the
      // user may misread as the final input bill.
      if (Object.keys(seed).length) setLedger(seed);
      mergeContextUsage({
        system: sysTokens,
        tools: toolTokens,
        runtime: runtimeTokens ?? historyTokens,
        total: contextTotal,
        ctxMax: contextMax,
        pct: contextPct,
      });
    }
    // Existing per-chat asst (mid tool loop): stop streaming the old wrap.
    const prev = state.pendingAsstByChat.get(chatId);
    if (prev) {
      prev.wrap.classList.remove('streaming');
      const visible = prev.body?.querySelector(
        '.blk-text, .blk-thinking, .blk-tool-use, .blk-tool-result, .blk-image-card, .tool-card, [data-aura-artifact-id], .msg-memory-card'
      ) || prev.body?.textContent?.trim();
      if (!visible) prev.wrap.remove();
    }
    // Build a placeholder assistant message DOM we mutate as chunks arrive.
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant streaming';
    wrap.dataset.chatId = chatId;
    const body = document.createElement('div');
    body.className = 'msg-body';
    const statusEl = document.createElement('div');
    statusEl.className = 'msg-status';
    statusEl.innerHTML = `<span class="msg-status-dot"></span><span class="msg-status-label">${
      iter > 0 ? 'Continuing after tool…' : 'Thinking…'
    }</span>`;
    body.appendChild(statusEl);
    wrap.appendChild(body);
    // Only attach root/orchestrator streaming to the visible main thread. If the
    // user is inspecting a leaf agent, keep the root bubble detached in
    // pendingAsstByChat; Back/reload will hydrate it into the orchestrator view.
    if (chatId === state.activeChatId && !state.activeAgentId) {
      els.threadInner.querySelector('.welcome-card')?.remove();
      setEmptyChatMode(false);
      els.threadInner.appendChild(wrap);
      // New turn fired by THIS user — re-arm follow so they see the start
      // of the response. After that, follow obeys their scroll position.
      scrollThreadToEnd(true);
    }
    state.pendingAsstByChat.set(chatId, {
      chatId,
      wrap, body, statusEl,
      blocks: new Map(),
      toolBuf: new Map(),
      flushPending: false,
    });
  }

  /** Update the streaming status banner to reflect the latest activity.
   *  Called from onChatChunk + onToolStart. Idempotent. Now per-chat. */
  function clearThinkingRotation(a) {
    if (a && a._thinkInterval) {
      clearInterval(a._thinkInterval);
      delete a._thinkInterval;
    }
  }
  function setStreamStatus(asst, label, sub) {
    const a = asst || getActivePendingAsst();
    if (!a || !a.statusEl) return;
    const lab = a.statusEl.querySelector('.msg-status-label');
    const rotating = /^(Thinking|Reasoning|Processing)/i.test(String(label || ''));
    if (rotating) {
      if (!a._thinkInterval) {
        let idx = 0;
        if (lab) lab.textContent = THINKING_LABELS[idx];
        a._thinkInterval = setInterval(() => {
          idx = (idx + 1) % THINKING_LABELS.length;
          const el = a.statusEl?.querySelector('.msg-status-label');
          if (el) el.textContent = THINKING_LABELS[idx];
        }, 2200);
      }
    } else {
      clearThinkingRotation(a);
      if (lab) lab.textContent = label || '';
    }
    let subEl = a.statusEl.querySelector('.msg-status-sub');
    if (sub) {
      if (!subEl) {
        subEl = document.createElement('span');
        subEl.className = 'msg-status-sub';
        a.statusEl.appendChild(subEl);
      }
      subEl.textContent = ' · ' + sub;
    } else if (subEl) {
      subEl.remove();
    }
    a.statusEl.hidden = false;
  }
  function hideStreamStatus(asst) {
    const a = asst || getActivePendingAsst();
    clearThinkingRotation(a);
    if (a && a.statusEl) a.statusEl.hidden = true;
  }

  function onChatChunk({ chatId, evt }) {
    const a = state.pendingAsstByChat.get(chatId);
    if (!a) return;
    const d = evt.data || {};

    switch (evt.event) {
      case 'content_block_start': {
        const cb = d.content_block; const i = d.index;
        if (cb && typeof i === 'number') {
          if (cb.type === 'text') {
            a.blocks.set(i, { type: 'text',     text: '' });
            setStreamStatus(a, 'Writing response…');
          }
          else if (cb.type === 'thinking') {
            a.blocks.set(i, { type: 'thinking', thinking: '' });
            setStreamStatus(a, 'Thinking…');
          }
          else if (cb.type === 'tool_use') {
            a.blocks.set(i, { type: 'tool_use', id: cb.id, name: cb.name, input: {} });
            a.toolBuf.set(i, '');
            // 0.4.177 — ask_user is a pseudo-tool that renders as a clarify
            // card. Signal it clearly while the model is composing the
            // question payload (streaming input_json can take several
            // seconds on longer clarifications).
            if (cb.name === 'ask_user') {
              setStreamStatus(a, 'Model đang soạn câu hỏi…');
            } else {
              setStreamStatus(a, 'Calling tool', cb.name);
            }
          }
        }
        scheduleFlush(a);
        break;
      }
      case 'content_block_delta': {
        const i = d.index, dl = d.delta;
        const blk = a.blocks.get(i);
        if (!blk || !dl) break;
        if (dl.type === 'text_delta'      && blk.type === 'text')     blk.text     += dl.text     ?? '';
        else if (dl.type === 'thinking_delta' && blk.type === 'thinking') blk.thinking += dl.thinking ?? '';
        else if (dl.type === 'input_json_delta' && blk.type === 'tool_use') {
          a.toolBuf.set(i, (a.toolBuf.get(i) ?? '') + (dl.partial_json ?? ''));
        }
        if (blk.type === 'text' && (blk.text?.length ?? 0) > 4) hideStreamStatus(a);
        scheduleFlush(a);
        break;
      }
      case 'content_block_stop': {
        const i = d.index, blk = a.blocks.get(i);
        if (blk?.type === 'tool_use') {
          const raw = a.toolBuf.get(i) ?? '';
          try { blk.input = raw ? JSON.parse(raw) : {}; } catch { blk.input = { _raw: raw }; }
        }
        scheduleFlush(a);
        break;
      }
      case 'message_delta': {
        // 0.4.6: removed mid-stream output-token accumulator. The host
        // already emits chat.usage and chat.done with cumulative totals; the
        // raw SSE message_delta fires once per inner tool-loop iteration so
        // adding it here double-counted output across multi-tool turns.
        break;
      }
    }
  }

  /**
   * Incremental flush — keep prior block DOM, only mutate the in-flight
   * block's content. Drops O(N) full-rerender per token to O(1) per flush.
   * Each block index gets its own <div data-idx=N> wrapper that we update.
   */
  function scheduleFlush(asst) {
    const a = asst || getActivePendingAsst();
    if (!a || a.flushPending) return;
    a.flushPending = true;
    requestAnimationFrame(() => {
      a.flushPending = false;
      // 0.4.392 — allow the final RAF flush while onChatDone still owns this
      // pending assistant bubble. `chat.done` can clear streamingChats before
      // the last raw-SSE render frame runs; dropping that frame makes the UI
      // look stuck/empty until a chat-switch hydrate. Once pendingAsstByChat no
      // longer points at this bubble, stale RAFs must still bail.
      const isCurrentPending = state.pendingAsstByChat.get(a.chatId) === a;
      if (!state.streamingChats.has(a.chatId) && !isCurrentPending) return;
      const ordered = [...a.blocks.entries()].sort((x, y) => x[0] - y[0]);
      // 0.4.36 — flag the live path so renderMarkdown emits the spinner
      // for unclosed ``` fences. Settled (replayed) messages never set
      // this so a fenced quote in a tool_result text can't trigger a
      // perpetual spinner.
      renderMarkdown._streamingNow = true;
      try {
      for (const [idx, blk] of ordered) {
        let slot = a.body.querySelector(`[data-blk-idx="${idx}"]`);
        if (!slot) {
          slot = document.createElement('div');
          slot.setAttribute('data-blk-idx', String(idx));
          a.body.appendChild(slot);
        }
        // Only re-render the slot that changed since last flush.
        const curHash = blockHash(blk, a.toolBuf.get(idx));
        if (slot.dataset.hash !== curHash) {
          // 0.4.146 — expose partial tool-use JSON to the renderer while
          // streaming. Without this, renderToolUse only sees blk.input={}
          // (parse happens at content_block_stop) and shows "(no input)"
          // for the whole run — user just watched the model call
          // sandbox__run_python with a 200-char Python script and saw
          // "(no input)" in the header until stop.
          if (blk.type === 'tool_use') blk._raw = a.toolBuf.get(idx) || '';
          slot.innerHTML = renderBlocks([blk]);
          slot.dataset.hash = curHash;
          hydrateImageCards(slot);
          // Highlight closed fences as they settle. A still-streaming
          // (unclosed) fence renders as the "Rendering…" spinner card, not
          // a pre.md-code, so it's naturally skipped until it closes.
          highlightCodeBlocks(slot);
        }
      }
      } finally { renderMarkdown._streamingNow = false; }
      // Surface code-fence artifacts (HTML / SVG / Mermaid) into the panel
      // — only for the ACTIVE chat. Background chats don't open panels.
      if (a.chatId === state.activeChatId && !state.activeAgentId && typeof harvestArtifactsFromBody === 'function') {
        harvestArtifactsFromBody(a.body);
      }
      try { purgeLegacyGhostCards(); } catch {}
      if (a.chatId === state.activeChatId && !state.activeAgentId) scrollThreadToEnd();
    });
  }
  function blockHash(blk, toolRaw) {
    if (blk.type === 'text')     return 't' + blk.text.length;
    if (blk.type === 'thinking') return 'h' + blk.thinking.length;
    if (blk.type === 'tool_use') return 'u' + (toolRaw || '').length + ':' + blk.name;
    return 'x';
  }

  function mergeContextUsage(next) {
    const cur = state.ctxUsage || { system: 0, tools: 0, runtime: 0, total: 0, ctxMax: 0, pct: 0 };
    const merged = { ...cur };
    for (const k of ['system', 'tools', 'runtime', 'total', 'ctxMax', 'pct']) {
      if (typeof next?.[k] === 'number' && Number.isFinite(next[k])) merged[k] = next[k];
    }
    if (!merged.total) merged.total = (merged.system || 0) + (merged.tools || 0) + (merged.runtime || 0);
    if (!merged.pct && merged.ctxMax) merged.pct = merged.total / merged.ctxMax;
    state.ctxUsage = merged;
    state.lastContextPct = merged.pct || 0;
    updateContextProgressBar();
    if (merged.ctxMax && merged.pct >= 0.85) surfaceContextPressure({ pct: merged.pct, used: merged.total, max: merged.ctxMax });
    else surfaceContextPressure({ pct: merged.pct || 0, used: merged.total || 0, max: merged.ctxMax || 0 });
  }

  function formatTok(n) {
    if (!Number.isFinite(n)) return '0';
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1000) return Math.round(n / 1000) + 'k';
    return String(Math.round(n));
  }

  function updateContextProgressBar(usageOverride) {
    const u = usageOverride || state.ctxUsage || {};
    const max = u.ctxMax || 0;
    let bar = document.getElementById('ctxProgress');
    const statusRow = document.getElementById('composerStatusRow');
    const composer = document.getElementById('composer');
    if (!bar && composer) {
      bar = document.createElement('div');
      bar.id = 'ctxProgress';
      bar.className = 'ctx-progress';
      if (statusRow) statusRow.prepend(bar);
      else composer.parentNode.insertBefore(bar, composer);
    }
    if (!bar) return;
    if (!max) { bar.hidden = true; return; }
    bar.hidden = false;
    const system = u.system || 0, tools = u.tools || 0, runtime = u.runtime || 0;
    const total = u.total || (system + tools + runtime);
    const pct = total / max;
    const unknown = Math.max(0, total - (system + tools + runtime));
    const rtClass = pct >= 1 ? 'overflow' : pct >= 0.95 ? 'danger' : pct >= 0.85 ? 'warn' : 'ok';
    const slots = 28;
    const partSlots = (v) => Math.max(0, Math.min(slots, Math.round((v / max) * slots)));
    let sysSlots = partSlots(system), toolSlots = partSlots(tools), runtimeSlots = partSlots(runtime), otherSlots = partSlots(unknown);
    let usedSlots = sysSlots + toolSlots + runtimeSlots + otherSlots;
    while (usedSlots > slots && runtimeSlots > 0) { runtimeSlots--; usedSlots--; }
    while (usedSlots > slots && toolSlots > 0) { toolSlots--; usedSlots--; }
    while (usedSlots > slots && sysSlots > 0) { sysSlots--; usedSlots--; }
    const emptySlots = Math.max(0, slots - usedSlots);
    const meter = `<span class="ctx-meter-sys">${'█'.repeat(sysSlots)}</span><span class="ctx-meter-tools">${'█'.repeat(toolSlots)}</span><span class="ctx-meter-runtime ${rtClass}">${'█'.repeat(runtimeSlots)}</span><span class="ctx-meter-other">${'█'.repeat(otherSlots)}</span><span class="ctx-meter-empty">${'░'.repeat(emptySlots)}</span>`;
    bar.className = `ctx-progress ctx-meter-${rtClass} ${pct >= 0.85 && pct < 0.95 ? 'pulse' : ''} ${pct >= 1 ? 'blink' : ''}`;
    bar.title = [
      `Context: ${total.toLocaleString()} / ${max.toLocaleString()} tokens (${Math.round(pct * 100)}%)`,
      `System: ${system.toLocaleString()}`,
      `Tools: ${tools.toLocaleString()}`,
      `Messages: ${runtime.toLocaleString()}`,
      unknown > 0 ? `Other: ${unknown.toLocaleString()}` : '',
    ].filter(Boolean).join('\n');
    bar.innerHTML = `<span class="ctx-meter-label">ctx</span> <span class="ctx-block-meter">[${meter}]</span> <span class="ctx-progress-label">${formatTok(total)} / ${formatTok(max)} · ${Math.round(pct * 100)}%</span>`;
  }

  async function refreshContextUsage(modelOverride) {
    if (!state.activeChatId) return;
    try {
      const r = await rpc('chats.contextUsage', { chatId: state.activeChatId, model: modelOverride || els.modelPicker?.value });
      if (r && r.ok) mergeContextUsage(r);
    } catch (e) { console.warn('[studio] contextUsage failed:', e); }
  }

  /** Live usage tick during streaming (#10 in 0.2.18 — was reporting 0/NaN
   *  because the host only sent zeros until chat.done). */
  function onChatUsage({ chatId, usage, costUsd, contextMax, contextUsed, contextPct }) {
    console.log('[studio] chat.usage', { chatId, active: state.activeChatId, usage, costUsd, contextPct });
    if (chatId !== state.activeChatId) return;
    setLedger({
      in:   usage?.inTokens  ?? 0,
      out:  usage?.outTokens ?? 0,
      cost: typeof costUsd === 'number' ? costUsd : 0,
    });
    if (typeof contextPct === 'number' && contextMax) {
      const known = state.ctxUsage || {};
      const fixed = (known.system || 0) + (known.tools || 0);
      const runtime = Math.max(0, (contextUsed || 0) - fixed);
      mergeContextUsage({ runtime, total: contextUsed, ctxMax: contextMax, pct: contextPct });
    }
  }

  /** Show / hide the context-near-full banner. Tiered:
        <70%   no banner
        70-85% info banner (yellow)
        85-95% warn banner (orange) — recommend compact
        >95%   danger (red) — compact strongly recommended
     The banner exposes a "Compact" button which calls chat.compact RPC. */
  function surfaceContextPressure({ pct, used, max }) {
    let banner = document.getElementById('ctxBanner');
    if (pct < 0.85) { if (banner) banner.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ctxBanner';
      banner.className = 'ctx-banner';
      const composer = document.getElementById('composer');
      composer.parentNode.insertBefore(banner, composer);
    }
    const tier = pct >= 0.95 ? 'danger' : pct >= 0.85 ? 'warn' : 'info';
    banner.dataset.tier = tier;
    const usedK = Math.round(used / 1000);
    const maxK  = Math.round(max  / 1000);
    const note  = pct >= 0.95
      ? 'Context is nearly full. The next send will compact automatically, or you can switch to a larger model.'
      : 'Context is getting full. Compact is recommended, but Aether will not auto-compact until 95%.';
    banner.innerHTML = `
      <div class="ctx-banner-text">
        <b>${(pct*100).toFixed(0)}% of context used</b>
        <span class="muted small"> · ${usedK}k / ${maxK}k tokens</span>
        <div class="ctx-banner-sub">${note}</div>
      </div>
      <div class="ctx-banner-actions">
        <button class="ghost-btn" data-act="ctx-dismiss">Dismiss</button>
        <button class="primary-btn" data-act="ctx-compact">Compact</button>
      </div>`;
    banner.querySelector('[data-act="ctx-dismiss"]').onclick = () => banner.remove();
    banner.querySelector('[data-act="ctx-compact"]').onclick = compactActiveChat;
  }
  async function compactActiveChat() {
    if (!state.activeChatId) return;
    const ok = await showConfirmModal(
      'Compact this chat?',
      'Aether will ask a model to summarize the full runtime into one compact note. Original full history is preserved locally on disk.',
      { okText: 'Compact', danger: false });
    if (!ok) return;
    try {
      // 0.4.154 — no longer awaits + toasts. The card handlers below surface
      // start/progress/done events emitted by the backend during summarize.
      rpc('chats.compact', { chatId: state.activeChatId })
        .catch(e => console.warn('[studio] compact failed:', e));
      const banner = document.getElementById('ctxBanner');
      if (banner) banner.remove();
    } catch (e) { console.warn('[studio] compact failed:', e); }
  }

  /** 0.4.154 — render a live compact card inline in the thread when the
   *  backend starts summarizing. Card updates in place: spinner → char
   *  counter → collapsible summary. Persists after the RPC completes. */
  function onCompactStart({ chatId, oldTurnCount, keepCount, newHeadTokens, tailTokens, ctxMax, incremental }) {
    if (chatId !== state.activeChatId) return;
    // Remove any prior compact card for this chat so the new one sits at
    // the tail (before compact happened it was showing older state).
    els.threadInner.querySelectorAll('.msg-compact-card').forEach(el => el.remove());
    const card = document.createElement('div');
    card.className = 'msg-compact-card';
    card.dataset.chatId = chatId;
    // 0.4.158 — headline in tokens (what actually drives context pressure)
    // with turn count as a small secondary detail.
    const kTok = newHeadTokens != null ? `${Math.round(newHeadTokens/1000)}k` : '';
    const label = incremental
      ? `Compacting ${kTok || oldTurnCount + ' new'} tokens (delta since last compact)…`
      : `Compacting ${kTok || oldTurnCount + ' turns'} of history…`;
    card.innerHTML = `
      <div class="mcc-head">
        <span class="mcc-spin"></span>
        <span>${escapeHtml(label)}</span>
      </div>
      <div class="mcc-progress muted">Waiting for summarizer…</div>
    `;
    card.dataset.keepCount = String(keepCount);
    els.threadInner.appendChild(card);
    scrollThreadToEnd(true);
  }
  function onCompactProgress({ chatId, chars }) {
    if (chatId !== state.activeChatId) return;
    const card = els.threadInner.querySelector(
      `.msg-compact-card[data-chat-id="${CSS.escape(chatId)}"]`);
    if (!card) return;
    const prog = card.querySelector('.mcc-progress');
    if (prog) prog.textContent = `Summarizing… ${chars.toLocaleString()} chars written`;
  }
  /** 0.4.155 — render a persistent, read-only summary card at the top of
   *  the thread for chats that already have a compact systemnote on disk.
   *  Called on every chat load. `noteText` is the raw markdown file
   *  contents (starts with "# Compacted history (…)"). Empty → no card. */
  function renderSystemNoteCard(chatId, noteText, boundaryTurnId, meta = {}) {
    if (chatId !== state.activeChatId) return;
    // 0.4.226 — if the summary text is missing but the chat has a compact
    // boundary on record, still show the card as a divider so the user knows
    // the chat has been compacted (summary may be lost from an older run).
    const hasBoundary = typeof boundaryTurnId === 'number' && boundaryTurnId > 0;
    const hasNote = !!(noteText && noteText.trim());
    if (!hasNote && !hasBoundary) return;
    if (!hasNote) noteText = '# Compacted history (summary unavailable)\n\n*This chat has a compact record but the summary text is not available on disk.*';
    // Drop any prior persistent card so re-entering the chat doesn't stack.
    els.threadInner.querySelectorAll('.msg-compact-card[data-persisted]').forEach(el => el.remove());
    // Extract the "N earlier messages" hint from the first heading line.
    const headMatch = noteText.match(/^#\s*Compacted history\s*\(([^)]+)\)/i);
    const headLabel = headMatch ? headMatch[1] : 'earlier turns';
    // 0.4.156 — strip the leading "# Compacted history (…)" heading + the
    // generated-at italics from the raw note. The card head already shows
    // that info; keeping it in the body just duplicates the label.
    const body = noteText
      .replace(/^#\s*Compacted history[^\n]*\n+/, '')
      .replace(/^\*Generated[^\n]*\*\s*\n+/, '')
      .trim();
    // Render as markdown so headings, tables, and code fences display
    // like the rest of the chat instead of raw hashes/asterisks.
    const rendered = (typeof renderMarkdown === 'function')
      ? renderMarkdown(body)
      : escapeHtml(body);
    const card = document.createElement('div');
    card.className = 'msg-compact-card done';
    card.dataset.persisted = '1';
    card.dataset.chatId = chatId;
    card.innerHTML = `
      <div class="mcc-head">
        <span>✓ Compacted ${escapeHtml(headLabel)} · full history preserved</span>
      </div>
      <details class="mcc-summary">
        <summary>Summary</summary>
        <div class="mcc-body mcc-body-md">${rendered}</div>
      </details>
      <div class="mcc-files muted small">
        Full history preserved locally.
        ${meta.historyPath ? `<button class="ghost-btn" data-act="copyHist">Copy history path</button>` : ''}
        ${meta.runtimePath ? `<button class="ghost-btn" data-act="copyRuntime">Copy runtime path</button>` : ''}
      </div>
    `;
    const copyHist = card.querySelector('[data-act="copyHist"]');
    if (copyHist) copyHist.onclick = () => navigator.clipboard?.writeText(meta.historyPath || '');
    const copyRuntime = card.querySelector('[data-act="copyRuntime"]');
    if (copyRuntime) copyRuntime.onclick = () => navigator.clipboard?.writeText(meta.runtimePath || '');
    // 0.4.206 — anchor the card at the compact boundary: place it BEFORE
    // the first surviving turn (data-turn-id === boundaryTurnId). Falls
    // back to appendChild if the anchor bubble isn't in the DOM (e.g.
    // boundary sits past the tail we render).
    let anchor = null;
    if (typeof boundaryTurnId === 'number') {
      anchor = els.threadInner.querySelector(
        `[data-turn-id="${boundaryTurnId}"]`);
    }
    if (anchor) anchor.parentNode.insertBefore(card, anchor);
    else els.threadInner.appendChild(card);
  }

  function onCompactDone({ chatId, ok, summary, summarizedCount, keptCount, error, newHeadTokens, tailTokens, ctxMax, incremental }) {
    if (chatId !== state.activeChatId) return;
    const card = els.threadInner.querySelector(
      `.msg-compact-card[data-chat-id="${CSS.escape(chatId)}"]`);
    if (!card) return;
    if (!ok) {
      card.classList.add('error');
      card.innerHTML = `
        <div class="mcc-head"><span>⚠ Compact failed</span></div>
        <div class="mcc-progress">${escapeHtml(error || 'unknown error')}</div>`;
      return;
    }
    // 0.4.225 — single card by design. Drop live progress card and render
    // only the persistent boundary card using the boundary + note from the
    // RPC (summarizedCount is a count, not a turnId — using it as anchor
    // made the card silently appendChild to the end or fail to render).
    card.remove();
    rpc('chats.systemNote', { chatId }).then(r => {
      const raw = (r && r.ok) ? (r.note || summary || '') : (summary || '');
      const boundary = (r && r.ok && typeof r.boundary === 'number') ? r.boundary : summarizedCount;
      renderSystemNoteCard(chatId, raw, boundary, r || {});
      refreshContextUsage();
    }).catch(() => {
      if (summary) renderSystemNoteCard(chatId, summary, summarizedCount);
      refreshContextUsage();
    });
  }

  /** 0.4.159 — inline card for the thinking-only auto-recurse loop.
   *  When the initial turn ended with only thinking blocks, the backend
   *  loops session.resume() with a hint until the model finally emits
   *  visible output OR total tokens hit ~85% of the ctx window. */
  /** 0.4.161 — legacy v0.4.159 recurse handlers. Backend no longer
   *  broadcasts chat.thinkingRecurse.* (replaced by chat.continuation.*),
   *  so these are unreachable in normal flow. Kept only to guard against
   *  a stale worker/proxy still emitting the old event names during a
   *  version-skew window; delete once no active session runs pre-0.4.161. */
  function onRecurseStart() { /* no-op — see chat.continuation.start */ }
  function onRecurseStep() { /* no-op */ }
  function onRecurseDone() { /* no-op */ }

  /** 0.4.161 — continuation loop start. Backend is about to (or has just
   *  begun) auto-continuing the current assistant turn across multiple
   *  API calls. Set the per-chat continuation flag so onAsstStart tags
   *  subsequent bubbles with .continuation-part (visually merged). Render
   *  an inline segment badge at the end of the current bubble strip. */
  function onContinuationStart({ chatId, ctxMax, initialTokens }) {
    state.continuationActive.add(chatId);
    if (chatId !== state.activeChatId) return;
    els.threadInner.querySelectorAll('.continuation-badge').forEach(el => el.remove());
    const badge = document.createElement('div');
    badge.className = 'continuation-badge';
    badge.dataset.chatId = chatId;
    badge.dataset.ctxMax = String(ctxMax || 0);
    badge.innerHTML = `
      <span class="cb-spin"></span>
      <span class="cb-label">segment 1 &middot; $0.0000</span>
      <button class="cb-stop-btn" type="button" title="Stop auto-continue">Stop</button>
    `;
    const stopBtn = badge.querySelector('.cb-stop-btn');
    if (stopBtn) stopBtn.onclick = () => {
      rpc('chat.cancel', { chatId }).catch(e => console.warn('[studio] continuation stop:', e));
    };
    els.threadInner.appendChild(badge);
    scrollThreadToEnd(true);
  }

  function onContinuationStep({ chatId, segment, tokensAccumulated, costUsd, ctxMax }) {
    if (chatId !== state.activeChatId) return;
    // 0.4.172 — one badge per segment boundary. The prior implementation
    // re-used the initial `.continuation-badge` and just rewrote its
    // label each step, so "after segment 1" got overwritten by
    // "after segment 2", "3", "4", … even though segment 1's tally was
    // already frozen the moment segment 2 started. Now: find any live
    // (non-.done) badge for this chat, freeze it as done, then append
    // a fresh badge for the new boundary.
    const kTok = Math.round((tokensAccumulated || 0) / 1000);
    const pct = ctxMax ? Math.round((tokensAccumulated / ctxMax) * 100) : 0;
    const cost = (costUsd || 0).toFixed(4);
    const prev = Math.max(1, (segment || 2) - 1);
    const frozenText = `after segment ${prev} · ~${kTok}k ctx (${pct}%) · $${cost}`;

    // Freeze any currently-live badge for this chat.
    const live = els.threadInner.querySelector(
      `.continuation-badge[data-chat-id="${CSS.escape(chatId)}"]:not(.done)`);
    if (live) {
      live.classList.add('done');
      live.innerHTML = `<span class="cb-label">${escapeHtml(frozenText)}</span>`;
    }

    // Create a fresh badge for the segment about to run.
    const badge = document.createElement('div');
    badge.className = 'continuation-badge';
    badge.dataset.chatId = chatId;
    badge.dataset.ctxMax = String(ctxMax || 0);
    badge.innerHTML = `
      <span class="cb-spin"></span>
      <span class="cb-label">${escapeHtml(`segment ${segment} · running…`)}</span>
      <button class="cb-stop-btn" type="button" title="Stop auto-continue">Stop</button>
    `;
    const stopBtn = badge.querySelector('.cb-stop-btn');
    if (stopBtn) stopBtn.onclick = () => {
      rpc('chat.cancel', { chatId }).catch(e => console.warn('[studio] continuation stop:', e));
    };
    els.threadInner.appendChild(badge);
    scrollThreadToEnd();
  }

  function onContinuationDone({ chatId, reason, segments, totalCost, finalTokens, ctxMax }) {
    state.continuationActive.delete(chatId);
    if (chatId !== state.activeChatId) return;
    // 0.4.172 — multiple badges now exist (one per segment boundary).
    // Terminal state lives on the LAST live badge; earlier ones are
    // already frozen with per-segment tallies.
    const badges = els.threadInner.querySelectorAll(
      `.continuation-badge[data-chat-id="${CSS.escape(chatId)}"]:not(.done)`);
    const badge = badges.length ? badges[badges.length - 1] : null;
    if (!badge) return;
    badge.classList.add('done');
    badge.classList.add(`reason-${reason}`);
    const kTok = Math.round((finalTokens || 0) / 1000);
    const pct = ctxMax ? Math.round((finalTokens / ctxMax) * 100) : 0;
    const cost = (totalCost || 0).toFixed(4);
    let msg = '';
    if (reason === 'success') {
      msg = segments > 1
        ? `${segments} segments · $${cost}`
        : ``; // single segment = normal reply, hide badge
    } else if (reason === 'budget-exceeded') {
      msg = `stopped at ~${kTok}k ctx (${pct}%). Click Continue to resume, or Compact first.`;
    } else if (reason === 'cancelled') {
      msg = `stopped by you after ${segments} segment${segments === 1 ? '' : 's'} · $${cost}`;
    } else {
      msg = `auto-continue error after ${segments} segment${segments === 1 ? '' : 's'}`;
    }
    if (!msg) {
      badge.remove();
      return;
    }
    badge.innerHTML = `<span class="cb-label">${escapeHtml(msg)}</span>`;
  }

  /** 0.4.163 — live continuation hint from backend. Render a compact
   *  foldable card summarising why AURA auto-continued this segment.
   *  Landing point: end of the active thread, right after the just-
   *  completed segment 1's bubble, before segment 2's stream fills in. */
  function onContinuationHint({ chatId, segment, hint, reason }) {
    if (chatId !== state.activeChatId) return;
    renderContinuationHintCard(String(hint || ''), { segment, reason });
  }

  /** Insert a .msg-continuation-hint-card into the current thread. Called
   *  from live broadcasts AND from history replay (skipped synthetic
   *  turns get one card per hint). */
  function renderContinuationHintCard(hintText, meta) {
    if (!hintText) return;
    const segment = meta && meta.segment;
    const reason  = meta && meta.reason;
    const turnId  = meta && meta.turnId;
    const agentId = meta && meta.agentId;

    // 0.4.172 — dedup consecutive identical hints. If the last child of
    // threadInner is already a hint card with the same body text, bump
    // its "× N" counter instead of appending yet another card. Fixes the
    // spam observed when the model returns thinking-only 5+ times in a
    // row and the backend fires THINKING_ONLY_CONTINUE_HINT each round.
    const last = els.threadInner.lastElementChild;
    if (last && last.classList && last.classList.contains('msg-continuation-hint-card')) {
      const lastPre = last.querySelector('.mch-hint');
      if (lastPre && lastPre.textContent === hintText) {
        const label = last.querySelector('.mch-label');
        if (label) {
          const cur = Number(last.dataset.count || '1') + 1;
          last.dataset.count = String(cur);
          const suffix = segment ? ` · segment ${segment}` : '';
          label.textContent = `Auto-continue hint × ${cur}${suffix}`;
        }
        return;
      }
    }

    const card = document.createElement('details');
    card.className = 'msg-continuation-hint-card';
    if (reason) card.dataset.reason = reason;
    card.dataset.count = '1';

    const summary = document.createElement('summary');
    summary.className = 'mch-summary';
    const label = document.createElement('span');
    label.className = 'mch-label';
    const suffix = segment ? ` · segment ${segment}` : '';
    label.textContent = `Auto-continue hint${suffix}`;
    const chev = document.createElement('span');
    chev.className = 'mch-chev muted small';
    chev.textContent = '▾';
    summary.appendChild(label);
    summary.appendChild(chev);
    if (turnId !== undefined && turnId !== null) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mch-delete';
      del.textContent = '✕';
      del.title = 'Delete this hint';
      del.addEventListener('click', async e => {
        e.preventDefault(); e.stopPropagation();
        const ok = await showConfirmModal('Delete this hint?', 'This synthetic resume hint will be removed from history and runtime.', { okText: 'Delete', danger: true });
        if (!ok) return;
        if (agentId) {
          await rpc('agents.deleteMessage', { chatId: state.activeChatId, agentId, absIndex: Number(turnId) });
          await openAgentThread(agentId);
        } else {
          await rpc('chats.deleteMessage', { chatId: state.activeChatId, absIndex: Number(turnId) });
          card.remove();
        }
      });
      summary.appendChild(del);
    }
    card.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'mch-body';
    const pre = document.createElement('pre');
    pre.className = 'mch-hint';
    pre.textContent = hintText;
    body.appendChild(pre);
    card.appendChild(body);

    els.threadInner.appendChild(card);
    scrollThreadToEnd();
  }

  /** 0.4.162 — model called the `ask_user` pseudo-tool. Render an
   *  interactive clarify card at the end of the active bubble strip
   *  with radio/checkbox groups per question + free-text notes +
   *  Submit / Skip. Submit posts chat.clarifyReply with a shape the
   *  backend's ToolExecutor turns into a tool_result. */
  function onClarifyAsk({ chatId, requestId, questions }) {
    if (chatId !== state.activeChatId) return;
    if (!Array.isArray(questions) || !questions.length) return;

    // 0.4.177 — the "Model đang soạn câu hỏi…" pill (set when the ask_user
    // tool_use started streaming) can now go — the questions have landed.
    const pending = state.pendingAsstByChat.get(chatId);
    if (pending) hideStreamStatus(pending);

    // Remove any prior clarify card for this chat (dedupe on rapid re-ask).
    els.threadInner.querySelectorAll(
      `.msg-clarify-card[data-chat-id="${CSS.escape(chatId)}"]`,
    ).forEach(el => el.remove());

    const card = document.createElement('div');
    card.className = 'msg-clarify-card';
    card.dataset.chatId = chatId;
    card.dataset.requestId = requestId;

    const header = document.createElement('div');
    header.className = 'mcc-header';
    header.textContent = `Model needs clarification — ${questions.length} question${questions.length === 1 ? '' : 's'}`;
    card.appendChild(header);

    const form = document.createElement('form');
    form.className = 'mcc-form';
    form.onsubmit = e => e.preventDefault();

    // Build one row per question. Radio (single) or checkbox (multi).
    // Each row also has a compact <textarea> for a free-text note that
    // rides alongside the picked options.
    questions.forEach((q, idx) => {
      const row = document.createElement('div');
      row.className = 'mcc-q';

      if (q.header) {
        const chip = document.createElement('span');
        chip.className = 'mcc-chip';
        chip.textContent = String(q.header).slice(0, 12);
        row.appendChild(chip);
      }

      const qLabel = document.createElement('div');
      qLabel.className = 'mcc-question';
      qLabel.textContent = String(q.question || '');
      row.appendChild(qLabel);

      if (q.description) {
        const desc = document.createElement('div');
        desc.className = 'mcc-desc';
        desc.textContent = String(q.description);
        row.appendChild(desc);
      }

      const opts = Array.isArray(q.options) ? q.options : [];
      const inputType = q.multiSelect ? 'checkbox' : 'radio';
      const groupName = `mcc-q-${requestId}-${idx}`;
      const optsWrap = document.createElement('div');
      optsWrap.className = 'mcc-opts';
      opts.forEach((opt, optIdx) => {
        const label = document.createElement('label');
        label.className = 'mcc-opt';
        const input = document.createElement('input');
        input.type  = inputType;
        input.name  = groupName;
        input.value = String(opt.label || `option-${optIdx}`);
        input.dataset.qIdx = String(idx);
        label.appendChild(input);
        const txt = document.createElement('span');
        txt.className = 'mcc-opt-label';
        txt.textContent = String(opt.label || '');
        label.appendChild(txt);
        if (opt.description) {
          const od = document.createElement('span');
          od.className = 'mcc-opt-desc';
          od.textContent = ` — ${opt.description}`;
          label.appendChild(od);
        }
        optsWrap.appendChild(label);
      });
      row.appendChild(optsWrap);

      const notes = document.createElement('textarea');
      notes.className = 'mcc-notes';
      notes.rows = 1;
      notes.placeholder = 'Notes (optional)';
      notes.dataset.qIdx = String(idx);
      row.appendChild(notes);

      form.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'mcc-actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'mcc-submit';
    submitBtn.textContent = 'Submit';
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'mcc-skip';
    skipBtn.textContent = 'Skip';
    actions.appendChild(submitBtn);
    actions.appendChild(skipBtn);
    form.appendChild(actions);

    card.appendChild(form);
    els.threadInner.appendChild(card);
    scrollThreadToEnd(true);

    /** 0.4.177 — after submit/skip, collapse the card into a one-line
     *  summary so it stops taking up the whole thread. Click summary to
     *  re-expand and review what was asked. Buttons + inputs stay disabled
     *  on re-expand so the reply isn't editable. */
    const disable = (skipped) => {
      card.classList.add('submitted');
      submitBtn.disabled = true;
      skipBtn.disabled   = true;
      form.querySelectorAll('input, textarea').forEach(el => { el.disabled = true; });

      const details = document.createElement('details');
      details.className = 'mcc-collapsed';
      const summary = document.createElement('summary');
      summary.className = 'mcc-collapsed-summary';
      summary.textContent = skipped
        ? `Clarified — skipped (${questions.length} question${questions.length === 1 ? '' : 's'})`
        : `Clarified — ${questions.length} question${questions.length === 1 ? '' : 's'} answered`;
      details.appendChild(summary);
      card.replaceChildren(details);
      details.appendChild(header);
      details.appendChild(form);
    };

    submitBtn.onclick = () => {
      // Gather selected options per question. For radio → single string in
      // an array; for checkbox → all checked labels. Notes come from the
      // matching textarea. Backend receives {answers: {q1: {selected, notes}}}.
      const answers = {};
      questions.forEach((q, idx) => {
        const key = String(q.question || `q${idx}`);
        const selected = [];
        form.querySelectorAll(
          `input[name="mcc-q-${CSS.escape(requestId)}-${idx}"]:checked`,
        ).forEach(i => { selected.push(i.value); });
        const noteEl = form.querySelector(`textarea.mcc-notes[data-q-idx="${idx}"]`);
        const notes  = noteEl && noteEl.value.trim() ? noteEl.value.trim() : undefined;
        answers[key] = { selected, ...(notes ? { notes } : {}) };
      });
      disable(false);
      rpc('chat.clarifyReply', { chatId, requestId, answers }).catch(e =>
        console.warn('[studio] clarifyReply:', e));
    };

    skipBtn.onclick = () => {
      disable(true);
      rpc('chat.clarifyReply', { chatId, requestId, skipped: true }).catch(e =>
        console.warn('[studio] clarifyReply skip:', e));
    };
  }


  function onChatDone({ chatId, stopReason, usage, costUsd }) {
    state.streamingChats.delete(chatId);
    const a = state.pendingAsstByChat.get(chatId);
    if (a) {
      clearThinkingRotation(a);
      if (a.statusEl) a.statusEl.remove();
      a.wrap.classList.remove('streaming');
      // 0.4.38/0.4.55 — re-render every text/thinking slot in
      // non-streaming mode so any "Rendering SVG…" spinner left over
      // from an unclosed fence turns into a real artifact OR the
      // "Output cut off" truncation card. Also force-replace any
      // remaining .md-streaming-fence elements directly — if the
      // slot's block map is empty (race / auto-retry) the loop above
      // skips it and the spinner is left orbiting forever.
      const slots = a.body.querySelectorAll('[data-blk-idx]');
      slots.forEach((slot) => {
        const idx = Number(slot.getAttribute('data-blk-idx'));
        const blk = a.blocks.get(idx);
        if (!blk) return;
        slot.innerHTML = renderBlocks([blk]);
        delete slot.dataset.hash;
        hydrateImageCards(slot);
        highlightCodeBlocks(slot);
      });
      // Defensive sweep: only label surviving streaming fences as cut off when
      // the backend actually stopped abnormally. A clean end_turn can still
      // leave a transient fence spinner after prose that mentions backticks.
      const shouldShowCutoff = stopReason === 'max_tokens' || stopReason === 'error' || stopReason === 'cancelled';
      if (shouldShowCutoff) {
        a.body.querySelectorAll('.md-streaming-fence').forEach(el => {
          const replacement = document.createElement('div');
          replacement.className = 'md-trunc-fence';
          replacement.innerHTML =
            '<span>⚠ Output was cut off before the block finished. ' +
            'Use Resend below to retry.</span>';
          el.replaceWith(replacement);
        });
        els.threadInner
          .querySelectorAll(`.msg-assistant[data-chat-id="${CSS.escape(chatId)}"] .md-streaming-fence`)
          .forEach(el => {
            const replacement = document.createElement('div');
            replacement.className = 'md-trunc-fence';
            replacement.innerHTML =
              '<span>⚠ Output was cut off before the block finished.</span>';
            el.replaceWith(replacement);
          });
      } else {
        a.body.querySelectorAll('.md-streaming-fence').forEach(el => el.remove());
      }
      // If user cancelled mid-stream, stamp the bubble visually + offer
      // a Resend on the trailing user message so the user can re-fire.
      if (stopReason === 'cancelled') {
        a.wrap.classList.add('cancelled');
        const note = document.createElement('div');
        note.className = 'msg-cancelled';
        note.textContent = '⏹ Stopped by you';
        a.body.appendChild(note);
        attachResendOnLastUser(chatId);
      }
      finalizeArtifactStrip(a.body);
      // 0.4.36/0.4.56 — surface a Resend hint only when the bubble is
      // truly empty (thinking-only fail). Detection: any of these
      // visible-content markers present? — text, tool_use, image, file,
      // SVG card, mermaid card, HTML card, or even just a truncated
      // fence card means the user got SOMETHING. The earlier check
      // missed .md-trunc-fence/.md-mermaid/.artifact-block and falsely
      // labelled good turns as empty (the symptom user reported: SVG
      // visible AND "Model finished without a response" hint above it).
      const visibleSel = [
        '.blk-text',
        '.blk-tool-use',
        '.blk-tool-result',
        '.blk-image-card',
        '.blk-file-card',
        '.tool-card',
        '.msg-image-wrap',
        '.msg-file-card',
        '.msg-memory-card',
        '[data-aura-artifact-id]',
        '.blk-svg-card',
        '.md-mermaid',
        '.artifact-block',
        '.md-trunc-fence',
      ].join(', ');
      // 0.4.392 — even a backend `thinking_only` stop can race with the
      // final RAF render / persisted-turn hydrate / artifact + memory cards.
      // Do NOT attach Resend immediately; first reconcile from source-of-truth,
      // then show the hint only if the bubble is still truly empty.
      const bodyRef = a.body;
      const maybeShowEmptyHint = () => {
        pruneFalseEmptyHints();
        const hasVisible = bodyRef.querySelector(visibleSel);
        if (!hasVisible && stopReason !== 'cancelled' && stopReason !== 'error') {
          const hint = document.createElement('div');
          hint.className = 'msg-empty-hint';
          hint.textContent = '⚠ Model finished without a response (thinking only). Use Resend below to retry.';
          bodyRef.appendChild(hint);
          attachResendOnLastUser(chatId);
        }
      };
      setTimeout(() => {
        if (chatId === state.activeChatId) {
          appendMissingTurns()
            .then(() => rpc('chats.cachedArtifacts', { chatId })
              .then(c => injectCachedArtifacts(chatId, c || {}))
              .catch(() => {}))
            .then(maybeShowEmptyHint)
            .catch(e => { console.warn('[studio] final hydrate failed:', e); maybeShowEmptyHint(); });
        } else {
          maybeShowEmptyHint();
        }
      }, 1500);
      setTimeout(() => {
        if (chatId === state.activeChatId) {
          appendMissingTurns().catch(e => console.warn('[studio] final hydrate failed:', e));
        }
      }, 0);
      state.pendingAsstByChat.delete(chatId);
    }
    if (chatId === state.activeChatId) {
      // Belt-and-suspenders: remove any stray .msg-status from prior turns.
      els.threadInner.querySelectorAll('.msg-status').forEach(el => el.remove());
      refreshComposerButtons();
      state.sessionCost += Number.isFinite(Number(costUsd)) ? Number(costUsd) : 0;
      setLedger({
        in:    usage?.inTokens ?? 0,
        out:   usage?.outTokens ?? 0,
        cost:  costUsd ?? 0,
        session: state.sessionCost,
      });
      // v0.2.19 — Reconcile any tool_result turns that landed in the DB
      // AFTER their tool.done broadcast fired. The host's per-tool
      // tool.done is emitted from executeToolCalls() before the outer
      // runToolLoop() does `appendTurn(tool_result)`, so the
      // appendMissingTurns() that ran from onToolDone may have missed the
      // freshly-appended turn (especially noticeable on first-turn-of-
      // chat python tool calls — the .docx/.png/.xlsx file card never
      // showed up until the next user prompt forced another DB read).
      // chat.done fires AFTER all tool_result appends → safe to refresh.
      appendMissingTurns().then(() => pruneFalseEmptyHints()).catch(() => pruneFalseEmptyHints());
      refreshContextUsage().catch(() => {});
    }
    refreshRecentChats();
    // v0.4.6 — Developer Mode auto-continue. The backend now distinguishes:
    //   done_marker     — model emitted [DONE]      → done, no button
    //   blocked_marker  — model emitted [BLOCKED:…] → done, no button
    //   inner_cap       — inner tool loop exhausted → render manual button
    //   outer_cap       — outer loop exhausted      → AUTO fire chat.resume
    //                                                  (bounded by a session
    //                                                  counter to avoid runaway)
    //   end_turn        — only happens in dev mode if a [DONE]/[BLOCKED]
    //                     check missed; safer to render the manual button.
    //   anything else (cancelled/error) — no button.
    // 0.4.164 — Non-dev manual ▶ Continue button removed by user request.
    // Auto-continue loop (runContinuationLoop) already handles thinking_only /
    // max_tokens / end_turn-without-[END], surfacing progress via
    // .continuation-badge and .msg-continuation-hint-card. The manual button
    // was firing on every clean end_turn — noisy and unwanted.
    if (state.developerMode && chatId === state.activeChatId
        && stopReason !== 'cancelled' && stopReason !== 'error'
        && stopReason !== 'done_marker' && stopReason !== 'blocked_marker') {
      state.devAutoCount = state.devAutoCount || new Map();
      const prior = state.devAutoCount.get(chatId) || 0;
      const MAX_AUTO = 6;   // ≈ 6 × 30 outer turns ≈ 180 model rounds
      const lastBody = els.threadInner.querySelector('.msg-assistant:last-of-type .msg-body');
      const shouldAutoContinue = stopReason === 'outer_cap' && prior < MAX_AUTO;
      if (shouldAutoContinue) {
        state.devAutoCount.set(chatId, prior + 1);
        // Surface a tiny banner so the user can see auto-continue is happening
        // (and stop it by hitting the composer Stop button).
        if (lastBody && !lastBody.querySelector('.resume-btn-wrap')) {
          const wrap = document.createElement('div');
          wrap.className = 'resume-btn-wrap';
          wrap.innerHTML = `<span class="muted small">⏩ Auto-continuing (${prior + 1}/${MAX_AUTO}) — press Stop to halt.</span>`;
          lastBody.appendChild(wrap);
        }
        rpc('chat.resume', {
          chatId,
          developerMode: true,
          temperature: readActiveTemperature(),
        })
          .then(r => { if (r && r.error) onChatError({ chatId, error: r.error }); })
          .catch(err => onChatError({ chatId, error: err.message }));
      } else if (lastBody && !lastBody.querySelector('.resume-btn-wrap')) {
        // Either auto-cap exhausted or stopReason is inner_cap/end_turn —
        // fall back to the manual ▶ Continue button.
        const wrap = document.createElement('div');
        wrap.className = 'resume-btn-wrap';
        const note = document.createElement('span');
        note.className = 'muted small';
        note.textContent = stopReason === 'outer_cap'
          ? `Auto-continue cap reached (${prior}). `
          : '';
        const btn = document.createElement('button');
        btn.className   = 'resume-btn';
        btn.title       = 'Continue outer loop (Developer Mode)';
        btn.textContent = '▶ Continue';
        btn.addEventListener('click', () => {
          btn.disabled = true;
          btn.textContent = '⏳ Running…';
          state.devAutoCount = state.devAutoCount || new Map();
          state.devAutoCount.set(chatId, 0);   // reset counter on manual nudge
          rpc('chat.resume', {
            chatId,
            developerMode: true,
            temperature: readActiveTemperature(),
          })
            .then(r => { if (r && r.error) onChatError({ chatId, error: r.error }); })
            .catch(err => onChatError({ chatId, error: err.message }))
            .finally(() => wrap.remove());
        });
        if (note.textContent) wrap.appendChild(note);
        wrap.appendChild(btn);
        lastBody.appendChild(wrap);
      }
    }
    // Reset the auto-continue counter on any clean terminal.
    if (state.devAutoCount && (
        stopReason === 'done_marker' ||
        stopReason === 'blocked_marker' ||
        stopReason === 'cancelled' ||
        stopReason === 'error')) {
      state.devAutoCount.delete(chatId);
    }
    // 0.4.203 — fold any newly-settled tool-only bubbles into their
    // adjacent tool-run-group. Runs after all end-of-turn re-renders
    // above so the block-type check sees the final DOM.
    try { groupAdjacentToolOnlyBubbles(); } catch { /* renderer not ready */ }
  }

  // ═════════════════════════════════════════════════════════════════════
  // 0.4.206 — SVG review loop UI. Backend refines diagrams post-turn;
  // frontend overlays a status banner on the SVG code block until done.
  // ═════════════════════════════════════════════════════════════════════
  function findAsstBubbleForTurn(chatId, turnId) {
    if (!els.threadInner) return null;
    const chatMatch = state.activeChatId === chatId;
    if (!chatMatch) return null;
    const bubbles = els.threadInner.querySelectorAll('.msg-assistant');
    // We keep turn indexing simple: last bubble on the thread is the
    // most recent asst turn. If backend passes turnId, prefer a data
    // attr; otherwise pick the last one.
    for (const b of bubbles) {
      if (b.getAttribute('data-turn-id') === String(turnId)) return b;
    }
    return bubbles[bubbles.length - 1] || null;
  }

  function pruneFalseEmptyHints(rootEl) {
    const root = rootEl || els.threadInner;
    root.querySelectorAll('.msg-assistant .msg-body').forEach(body => {
      const hasReal = !!body.querySelector('.blk-text, .blk-tool-use, .blk-tool-result, .blk-image-card, .blk-file-card, .msg-image-wrap, .msg-file-card, .art-image, .art-svg, .art-html-card, .artifact-block, .md-mermaid');
      if (hasReal) body.querySelectorAll('.msg-empty-hint').forEach(el => el.remove());
      const bubble = body.closest('.msg-assistant');
      if (bubble && !bubble.classList.contains('streaming')) {
        body.querySelectorAll('.md-streaming-fence').forEach(el => el.remove());
      }
    });
  }

  function removeFollowingErrorOnlyAssistant(userEl) {
    // 0.4.149 — also drop asst bubbles whose only content is the "⏹ Stopped
    // by you" note or the "⚠ Model finished without a response (thinking
    // only)" hint. Previously only .msg-error asst bubbles were removed, so
    // cancelling a turn then clicking the resend-row Delete left the empty
    // cancel-note bubble behind (visible after reload as an orphan).
    const emptyMarkers = ['.msg-error', '.msg-cancelled', '.msg-empty-hint'];
    let sib = userEl?.nextElementSibling;
    while (sib && sib.classList.contains('msg-assistant')) {
      const next = sib.nextElementSibling;
      const hasMarker = emptyMarkers.some(sel => !!sib.querySelector(sel));
      const excludeSel = emptyMarkers.map(s => `:not(${s})`).join('') + ':not(.msg-status)';
      const hasRealContent = !!sib.querySelector('.msg-body > *' + excludeSel);
      if (hasMarker && !hasRealContent) sib.remove();
      sib = next;
    }
  }

  /** Attach a "↻ Resend" affordance to the trailing user message of the
     given chat. Only added when the prior turn ended in error or was
     cancelled — in both cases the user's message is "stuck", awaiting a
     redo. Click re-fires the same text via the normal sendMessage path
     (which knows how to attach + persist). Idempotent. */
  function attachResendOnLastUser(chatId) {
    if (chatId !== state.activeChatId) return;
    const userBubbles = els.threadInner.querySelectorAll('.msg-user');
    const last = userBubbles[userBubbles.length - 1];
    if (!last || last.querySelector('.resend-btn-wrap')) return;
    const text = (last.querySelector('.msg-body')?.innerText || '').trim();
    if (!text) return;
    const wrap = document.createElement('div');
    wrap.className = 'resend-btn-wrap';

    const btn = document.createElement('button');
    btn.className = 'resend-btn';
    btn.title = 'Resend this message';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg> Resend';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      els.composerInput.value = text;
      wrap.remove();
      sendMessage();
    });

    // Sibling delete button (#F2 in 0.4.2). Idempotent with the per-bubble
    // trash icon — this one is just easier to reach right after an abort.
    const del = document.createElement('button');
    del.className = 'resend-btn resend-btn-danger';
    del.title = 'Delete this message';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg> Delete';
    del.addEventListener('click', async () => {
      const ok = await showConfirmModal(
        'Delete this message?',
        'This message and its (empty/cancelled) reply will be removed.',
        { okText: 'Delete', danger: true });
      if (!ok) return;
      // 0.4.149 — was calling chats.deleteMessage which only removes the
      // single user row; the paired cancelled/thinking-only asst turn stayed
      // in the JSONL, so reload re-hydrated it as an orphan bubble at the
      // bottom of the thread. chats.deleteTurn cascades the reply so the
      // JSONL matches what the DOM cleanup below does.
      const turnId = last?.dataset?.turnId;
      if (turnId !== undefined && turnId !== '') {
        try {
          await rpc('chats.deleteTurn', {
            chatId: state.activeChatId,
            turnId: Number(turnId),
          });
        } catch (e) { console.warn('[studio] resend-row delete failed:', e); }
      }
      last.classList.add('deleting');
      setTimeout(() => {
        removeFollowingErrorOnlyAssistant(last);
        last.remove();
      }, 180);
    });

    wrap.appendChild(btn);
    wrap.appendChild(del);
    last.appendChild(wrap);
  }

  function onChatError({ chatId, error }) {
    console.warn('[studio] chat.error:', error);
    state.streamingChats.delete(chatId);
    const a = state.pendingAsstByChat.get(chatId);
    if (a?.statusEl) a.statusEl.remove();
    // 0.4.40 — "aborted" is the network signal, not a human-readable
    // reason. Translate it for the user and add a hint about likely
    // causes (concurrent send, stop button, proxy timeout).
    const friendly = /^aborted$/i.test(String(error || '').trim())
      ? 'Stream was cancelled mid-flight. Common causes: a newer message replaced this one, the Stop button was pressed, or the proxy disconnected. Use Resend below to retry.'
      : `Error: ${error}`;
    if (a) {
      const err = document.createElement('div');
      err.className = 'msg-error';
      err.textContent = friendly;
      a.body.appendChild(err);
      a.wrap.classList.remove('streaming');
      state.pendingAsstByChat.delete(chatId);
    }
    attachResendOnLastUser(chatId);
    if (!a && (chatId === state.activeChatId || !chatId)) {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      const body = document.createElement('div');
      body.className = 'msg-body';
      const err = document.createElement('div');
      err.className = 'msg-error';
      err.innerHTML = `<b>Could not send:</b> ${escapeHtml(error)}<br><br>` +
        `<span class="muted small">Tip: open Settings and make sure a provider is connected, ` +
        `and that a proxy entry is started.</span>`;
      body.appendChild(err);
      wrap.appendChild(body);
      els.threadInner.appendChild(wrap);
      scrollThreadToEnd();
    }
    if (chatId === state.activeChatId) {
      els.threadInner.querySelectorAll('.msg-status').forEach(el => el.remove());
      refreshComposerButtons();
    }
  }

  function setLedger(_payload) { /* 0.4.176 — ledger footer removed; no-op kept for call sites. */ }

  /* ── UI bindings ────────────────────────────────────────────────── */
  /* ── splitter drag (resize left rail) ─────────────────── */
  function bindSplitter() {
    if (!els.splitter) return;
    const RAIL_KEY = 'auraStudio.railWidth';
    const minW = 180, maxW = 520;
    // Restore saved width from localStorage (per-window) — keep it simple,
    // no host roundtrip needed for ephemeral UI prefs.
    const saved = parseInt(localStorage.getItem(RAIL_KEY) || '260', 10);
    if (!Number.isNaN(saved)) document.documentElement.style.setProperty('--rail-w', `${Math.max(minW, Math.min(maxW, saved))}px`);

    // Pointer events + capture so the divider stops following the cursor
    // the moment the user releases — even if the pointer is over an iframe
    // or webview overlay (issue #3a in 0.4.1).
    let pid = null;
    let lastX = 0;
    let lastW = Math.max(minW, Math.min(maxW, saved));
    let raf = 0;
    const applyDrag = () => {
      raf = 0;
      if (pid === null) return;
      lastW = Math.max(minW, Math.min(maxW, lastX));
      document.documentElement.style.setProperty('--rail-w', `${lastW}px`);
    };
    els.splitter.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      lastX = e.clientX;
      els.splitter.setPointerCapture(pid);
      els.splitter.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    els.splitter.addEventListener('pointermove', (e) => {
      if (pid === null) return;
      lastX = e.clientX;
      if (!raf) raf = requestAnimationFrame(applyDrag);
    });
    const release = () => {
      if (pid === null) return;
      try { els.splitter.releasePointerCapture(pid); } catch {}
      pid = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      els.splitter.classList.remove('dragging');
      document.body.style.userSelect = '';
      localStorage.setItem(RAIL_KEY, String(lastW));
    };
    els.splitter.addEventListener('pointerup',     release);
    els.splitter.addEventListener('pointercancel', release);
    window.addEventListener('blur',                release);
  }

  /* ── 0.4.175 — sidebar collapse/expand ─────────────────── */
  function bindRailCollapse() {
    const KEY = 'auraStudio.railCollapsed';
    const applyCollapsed = (collapsed) => {
      document.body.classList.toggle('rail-collapsed', collapsed);
      if (els.railExpandTab) els.railExpandTab.hidden = !collapsed;
    };
    const initial = localStorage.getItem(KEY) === '1';
    applyCollapsed(initial);
    const setCollapsed = (v) => {
      applyCollapsed(v);
      try { localStorage.setItem(KEY, v ? '1' : '0'); } catch {}
    };
    if (els.railCollapseBtn) els.railCollapseBtn.addEventListener('click', () => setCollapsed(true));
    if (els.railExpandTab)   els.railExpandTab.addEventListener('click',   () => setCollapsed(false));
  }

  /* ── 0.4.23 — rail horizontal splitter (Recent ↔ Projects)
   *
   * Simple model that doesn't fight flex layout:
   *   • Both sections use `flex: <weight> 1 0`. The rail divides remaining
   *     vertical space proportionally between them — never overflows.
   *   • Drag updates the ratio; flex re-lays out instantly.
   *   • One number persisted: `recentRatio` in (0, 1). Default 0.5.
   * No pixel heights, no `.is-sized` class, no resize listeners.
   * The rail's overflow:hidden is irrelevant because flex never spills. */
  function bindRailSectionSplitter() {
    const handle = document.getElementById('railSectionSplitter');
    const top    = document.getElementById('recentSection');
    const bot    = document.getElementById('projectsSection');
    const rail   = document.querySelector('.rail');
    if (!handle || !top || !bot || !rail) return;
    const KEY = 'auraStudio.railRecentRatio';
    const MIN_RATIO = 0.15;
    const MAX_RATIO = 0.85;

    // Drop legacy pixel-height keys from 0.4.14-0.4.22.
    localStorage.removeItem('auraStudio.railRecentH');
    localStorage.removeItem('auraStudio.railProjectsH');

    const applyRatio = (r) => {
      const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, r));
      top.style.flex = `${clamped} 1 0`;
      bot.style.flex = `${1 - clamped} 1 0`;
      top.style.height = '';
      bot.style.height = '';
      rail.classList.add('rail-ratio');
      return clamped;
    };

    const saved = parseFloat(localStorage.getItem(KEY) || '');
    applyRatio(Number.isFinite(saved) ? saved : 0.5);

    let dragging = false;
    let lastY = 0;
    let lastRatio = Number.isFinite(saved) ? saved : 0.5;
    let raf = 0;
    const applyDrag = () => {
      raf = 0;
      if (!dragging) return;
      // Compute ratio from cursor position relative to the combined span
      // of the two sections. This is robust to window resize, padding,
      // and whatever else mid-drag — but throttle to one layout read/write
      // per animation frame so dragging stays smooth.
      const tRect = top.getBoundingClientRect();
      const bRect = bot.getBoundingClientRect();
      const top0  = tRect.top;
      const bot1  = bRect.bottom;
      const span  = bot1 - top0;
      if (span < 40) return;
      lastRatio = applyRatio((lastY - top0) / span);
    };
    const onMove = (e) => {
      if (!dragging) return;
      lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(applyDrag);
      e.preventDefault();
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      localStorage.setItem(KEY, String(lastRatio));
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup',   stop,   true);
    };
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup',   stop,   true);
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('blur', stop);
    handle.addEventListener('dblclick', () => {
      applyRatio(0.5);
      localStorage.setItem(KEY, '0.5');
    });
  }


  async function exportActiveChatAsMarkdown() {
    if (!state.activeChatId) {
      await showInputModal('No chat selected', '');   // soft hint
      return;
    }
    try {
      const r = await rpc('chats.export', { chatId: state.activeChatId });
      if (r?.cancelled) return;
      if (r?.ok && r.markdown) {
        downloadTextFile(r.filename || 'chat.md', r.markdown, 'text/markdown');
        showToast('Chat exported');
      }
    } catch (e) {
      console.warn('[studio] export failed:', e);
    }
  }

  /** Trigger a browser download of a text blob — no native save dialog
   *  standalone, so export/snapshot RPCs return content and this drives
   *  the actual save via a throwaway <a download> link. */
  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Shared "download this file/artifact" — replaces the old native
   *  save-dialog RPC. Picks artifact.saveAs vs file.saveAs same as before;
   *  both now return { ok, dataUri, filename } instead of writing to disk
   *  server-side, so this triggers the actual browser download. */
  async function saveAsDownload({ id, chatId, agentId, path } = {}) {
    let r;
    try {
      r = id
        ? await rpc('artifact.saveAs', { chatId, id, agentId })
        : await rpc('file.saveAs', { path: path || '' });
      if (r?.dataUri) {
        const a = document.createElement('a');
        a.href = r.dataUri;
        a.download = r.filename || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } else if (r?.error) {
        console.warn('[studio] saveAs failed:', r.error);
      }
    } catch (e) {
      console.warn('[studio] saveAs failed:', e);
      r = { error: String(e && e.message || e) };
    }
    return r;
  }

  /* 0.4.248 — HTML snapshot: clone #thread, inline linked CSS, extract
     images (data: / blob: / http:) to sidecar assets folder. Backend
     saves .html + <name>_assets/img-NN.<ext>. Meant for debug/share
     with Claude — text/SVG stay inline, PNG/JPEG become sibling files. */
  async function exportActiveChatAsHtml() {
    if (!state.activeChatId) { await showInputModal('No chat selected', ''); return; }
    try {
      const thread = document.getElementById('thread');
      if (!thread) return;

      // Walk LIVE thread imgs first — fetch on webview-resource URLs is
      // CSP-blocked, but canvas.drawImage() on an already-rendered <img>
      // works. Build a src → sidecar name map, then clone + rewrite.
      const liveImgs = Array.from(thread.querySelectorAll('img'));
      const assets = [];
      const srcMap = new Map();
      let idx = 0;
      for (const img of liveImgs) {
        if (img.classList.contains('empty-logo')) continue;
        const src = img.getAttribute('src') || '';
        if (!src || srcMap.has(src)) continue;
        const alt = img.getAttribute('alt') || '';
        let dataUri = null;
        try {
          if (src.startsWith('data:')) {
            dataUri = src;
          } else if (img.complete && img.naturalWidth > 0) {
            // Try canvas — works for same-origin webview-resource URLs.
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              canvas.getContext('2d').drawImage(img, 0, 0);
              dataUri = canvas.toDataURL('image/png');
            } catch (canvasErr) {
              // Tainted / SVG without dims — fall through to fetch.
            }
          }
          if (!dataUri) {
            // Last resort: fetch (works for blob:, sometimes vscode-webview:).
            const blob = await (await fetch(src)).blob();
            dataUri = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result || ''));
              fr.onerror = () => rej(fr.error);
              fr.readAsDataURL(blob);
            });
          }
        } catch (e) {
          console.warn('[studio] snapshot image failed:', src.slice(0, 80), e);
          continue;
        }
        if (!dataUri) continue;
        const m = /^data:([^;,]+)[;,]/.exec(dataUri);
        const mime = m ? m[1] : 'image/png';
        const ext = ({
          'image/png':'png','image/jpeg':'jpg','image/webp':'webp',
          'image/gif':'gif','image/svg+xml':'svg',
        })[mime] || 'bin';
        idx++;
        const name = `img-${String(idx).padStart(3, '0')}.${ext}`;
        assets.push({ name, dataUri, alt });
        srcMap.set(src, name);
      }

      const clone = thread.cloneNode(true);
      for (const img of clone.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        const name = srcMap.get(src);
        if (name) {
          img.setAttribute('src', `__ASSETS_DIR__/${name}`);
        }
      }

      // Inline stylesheets (fetch each linked CSS in document order).
      const styleParts = [];
      const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      for (const link of links) {
        const href = link.getAttribute('href');
        if (!href) continue;
        try {
          const css = await (await fetch(href)).text();
          styleParts.push(`/* ${href} */\n${css}`);
        } catch (e) {
          console.warn('[studio] snapshot css failed:', href, e);
        }
      }
      // Also drop any <style> the app injected (e.g. hljs runtime).
      for (const s of document.querySelectorAll('style')) {
        if (s.textContent) styleParts.push(s.textContent);
      }

      const title = (document.querySelector('#chatTitle')?.textContent || 'chat').trim() || 'chat';
      const html =
`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — Aether snapshot</title>
<style>${styleParts.join('\n\n')}</style>
</head><body class="${document.body.className.split(/\s+/).filter(c => !c.startsWith('vscode-')).join(' ')}">
<div id="app"><main class="main">
${clone.outerHTML}
</main></div>
</body></html>`;

      const r = await rpc('chats.exportHtml', {
        chatId: state.activeChatId,
        title,
        html,
        assets,   // [{name, dataUri, alt}]
      });
      if (r?.cancelled) return;
      if (r?.ok && r.html) {
        downloadTextFile(r.filename || 'chat_snapshot.html', r.html, 'text/html');
        showToast('Snapshot exported');
      }
    } catch (e) {
      console.warn('[studio] html snapshot failed:', e);
      showToast('Snapshot failed — see console', 'error');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[c]);
  }
  function showToast(msg, kind, durationMs) {
    let t = document.getElementById('auraToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'auraToast';
      t.className = 'aura-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    // Kind hint: 'warn' / 'error' / undefined. Reset prior modifier first.
    t.classList.remove('warn', 'error');
    if (kind === 'warn' || kind === 'error') t.classList.add(kind);
    t.classList.add('show');
    clearTimeout(showToast._tid);
    const ms = Math.max(800, Number(durationMs) || 2400);
    showToast._tid = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* Drag the composer's top edge to resize its max textarea height.
     Persists the value in localStorage. Range: 80–520px. */
  function bindComposerResize() {
    const handle = document.getElementById('composerResize');
    if (!handle || handle.dataset.bound) return;
    handle.dataset.bound = '1';
    const KEY = 'auraStudio.composerMaxH';
    const minH = 80, maxH = 520;
    const apply = (h) => {
      const clamped = Math.max(minH, Math.min(maxH, h));
      document.documentElement.style.setProperty('--composer-max-h', `${clamped}px`);
      return clamped;
    };
    const saved = parseInt(localStorage.getItem(KEY) || '240', 10);
    if (!Number.isNaN(saved)) apply(saved);

    let pid = null, startY = 0, startH = 0, lastY = 0, raf = 0;
    let lastH = Number.isNaN(saved) ? 240 : saved;
    const applyDrag = () => {
      raf = 0;
      if (pid === null) return;
      // Drag UP grows the composer (max-height +), drag DOWN shrinks it.
      lastH = apply(startH + (startY - lastY));
    };
    handle.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      handle.setPointerCapture(pid);
      handle.classList.add('dragging');
      startY = lastY = e.clientY;
      const cur = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--composer-max-h'), 10);
      startH = Number.isNaN(cur) ? 240 : cur;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (pid === null) return;
      lastY = e.clientY;
      if (!raf) raf = requestAnimationFrame(applyDrag);
    });
    const release = () => {
      if (pid === null) return;
      try { handle.releasePointerCapture(pid); } catch {}
      pid = null;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      localStorage.setItem(KEY, String(lastH));
    };
    handle.addEventListener('pointerup',     release);
    handle.addEventListener('pointercancel', release);
    window.addEventListener('blur',          release);
  }

  /* ── inline input modal (replaces window.prompt) ──────────── */
  function showInputModal(title, defaultValue = '') {
    return new Promise((resolve) => {
      const ov = $('#modalOverlay');
      const ti = $('#modalTitle');
      const msg = $('#modalMessage');
      const inp = $('#modalInput');
      const ok = $('#modalOk');
      const cancel = $('#modalCancel');
      ti.textContent = title;
      if (msg) { msg.hidden = true; msg.textContent = ''; }
      inp.hidden = false;
      inp.value = defaultValue;
      ok.textContent = 'OK';
      ok.classList.remove('danger-btn');
      ov.hidden = false;
      setTimeout(() => inp.focus(), 0);

      const cleanup = (v) => {
        ov.hidden = true;
        ok.onclick = null; cancel.onclick = null; inp.onkeydown = null;
        document.removeEventListener('keydown', onEsc, true);
        resolve(v);
      };
      const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(null); } };
      document.addEventListener('keydown', onEsc, true);
      ok.onclick = () => cleanup(inp.value.trim() || null);
      cancel.onclick = () => cleanup(null);
      inp.onkeydown = (e) => {
        if (e.key === 'Enter')   { e.preventDefault(); cleanup(inp.value.trim() || null); }
        if (e.key === 'Escape')  { e.preventDefault(); cleanup(null); }
      };
    });
  }

  /** Yes/No confirmation popup. Resolves true if user clicked OK, false otherwise.
   *  Replaces the type-the-name flow which felt friction-heavy for routine deletes. */
  function showConfirmModal(title, message, opts = {}) {
    return new Promise((resolve) => {
      const ov = $('#modalOverlay');
      const ti = $('#modalTitle');
      const msg = $('#modalMessage');
      const inp = $('#modalInput');
      const ok = $('#modalOk');
      const cancel = $('#modalCancel');
      ti.textContent = title;
      if (msg) {
        msg.hidden = false;
        msg.textContent = message || '';
      }
      inp.hidden = true;
      inp.value = '';
      ok.textContent = opts.okText || 'Delete';
      ok.classList.toggle('danger-btn', opts.danger !== false);
      ov.hidden = false;
      setTimeout(() => ok.focus(), 0);

      const cleanup = (v) => {
        ov.hidden = true;
        // Restore input visibility for next showInputModal call.
        inp.hidden = false;
        if (msg) { msg.hidden = true; msg.textContent = ''; }
        ok.classList.remove('danger-btn');
        ok.onclick = null; cancel.onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
        else if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
      };
      document.addEventListener('keydown', onKey, true);
      ok.onclick = () => cleanup(true);
      cancel.onclick = () => cleanup(false);
    });
  }

  async function deleteTurnFlow(turnId, msgEl) {
    if (turnId === undefined || turnId === null) return;
    // v0.4.1 #13 — single-message delete (no cascade). The trash icon now
    // removes ONLY the clicked bubble; the paired user/assistant message
    // is left intact so users can prune individual lines from a long
    // history without losing the surrounding context.
    const ok = await showConfirmModal(
      'Delete this message?',
      'Only this message will be removed. Its pair stays in the thread.',
      { okText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await rpc('chats.deleteMessage', {
        chatId:   state.activeChatId,
        absIndex: Number(turnId),
      });
      if (msgEl) {
        msgEl.classList.add('deleting');
        setTimeout(() => msgEl.remove(), 180);
      }
    } catch (e) { console.warn('[studio] deleteMessage failed:', e); }
  }

  async function deleteChatFlow(chatId) {
    if (!chatId) return;
    const chat = state.chats.find(c => c.id === chatId);
    const title = chat?.title || '(untitled)';
    const ok = await showConfirmModal(
      'Delete chat?',
      `"${title}" and all its messages will be permanently deleted.`,
      { okText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await rpc('chats.delete', { id: chatId });
      // If we just nuked the open chat, drop the empty state back in.
      if (state.activeChatId === chatId) {
        state.activeChatId = null;
        els.threadInner.innerHTML = renderWelcomeCard();
        bindWelcomeChips();
      }
      // Host broadcasts state.invalidate { scope: 'chats' } already.
    } catch (e) {
      console.warn('[studio] delete chat failed:', e);
    }
  }

  /** Rename a project. Used by both the project view header AND the left rail. */
  async function projectRenameFlow(projectId) {
    if (!projectId) return;
    const cur = state.projects.find(p => p.id === projectId)?.name || '';
    const next = await showInputModal('Rename project:', cur);
    if (!next || next === cur) return;
    await rpc('projects.rename', { id: projectId, name: next });
    if (state.activeProjectId === projectId && els.projectTitle) {
      els.projectTitle.textContent = next;
    }
    await refreshProjects();
  }

  async function chatRenameFlow(chatId) {
    if (!chatId) return;
    const cur = state.chats.find(c => c.id === chatId)?.title
      || state.projectChatsCache.find(c => c.id === chatId)?.title
      || '';
    const next = await showInputModal('Rename chat:', cur);
    if (!next || next === cur) return;
    await rpc('chats.rename', { id: chatId, title: next });
    await refreshRecentChats();
    if (state.view === 'project' && state.activeProjectId) {
      try {
        const chats = await rpc('chats.listByProject', { projectId: state.activeProjectId });
        renderProjectChatList(chats);
      } catch {}
    }
  }

  /** Delete a project (cascades all its chats). Last project is protected. */
  async function projectDeleteFlow(projectId) {
    if (!projectId) return;
    if (state.projects.length <= 1) {
      // Inline status if we're inside the project view, else fall through.
      if (els.projectDescStatus) {
        els.projectDescStatus.textContent = '✗ cannot delete the only project';
        setTimeout(() => { els.projectDescStatus.textContent = ''; }, 2500);
      }
      return;
    }
    const proj = state.projects.find(p => p.id === projectId);
    const ok = await showConfirmModal(
      'Delete project?',
      `"${proj?.name || 'Untitled'}" and all of its chats will be permanently deleted.`,
      { okText: 'Delete', danger: true });
    if (!ok) return;
    await rpc('projects.delete', { id: projectId });
    if (state.activeProjectId === projectId) {
      state.activeProjectId = null;
      leaveProjectView();
    }
    await refreshProjects();
  }

  /** Bulk delete a list of chat ids — single confirmation prompt covering all of them. */
  async function deleteChatsFlow(ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    const ok = await showConfirmModal(
      `Delete ${ids.length} chat${ids.length === 1 ? '' : 's'}?`,
      `These chats and all their messages will be permanently deleted.`,
      { okText: 'Delete', danger: true });
    if (!ok) return;
    let nuked = 0;
    for (const id of ids) {
      try {
        await rpc('chats.delete', { id });
        nuked++;
        if (state.activeChatId === id) {
          state.activeChatId = null;
          els.threadInner.innerHTML = renderWelcomeCard();
          bindWelcomeChips();
        }
      } catch (e) { console.warn('[studio] delete chat failed:', id, e); }
    }
    return nuked;
  }

  /** Collapse / restore the Recent + Projects rail sections. State persists. */
  function bindRailSectionToggles() {
    const sections = [
      { key: 'auraStudio.recentCollapsed',   sec: '#recentSection',   btn: '#recentToggle' },
      { key: 'auraStudio.projectsCollapsed', sec: '#projectsSection', btn: '#projectsToggle' },
    ];
    for (const s of sections) {
      const sec = document.querySelector(s.sec);
      const btn = document.querySelector(s.btn);
      if (!sec || !btn) continue;
      const startCollapsed = localStorage.getItem(s.key) === '1';
      sec.classList.toggle('collapsed', startCollapsed);
      btn.onclick = () => {
        const now = !sec.classList.contains('collapsed');
        sec.classList.toggle('collapsed', now);
        localStorage.setItem(s.key, now ? '1' : '0');
      };
    }
  }

  /* ── Temperature slider ──────────────────────────────────────────── */
  // Three named anchors on the [0, 1.5] range. The chip cycles through
  // them; dragging the slider to any value updates the chip label too.
  const TEMP_PRESETS = [
    { state: 'precise',  value: 0.2 },
    { state: 'balanced', value: 0.7 },
    { state: 'creative', value: 1.2 },
  ];
  function tempStateForValue(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'balanced';
    if (n <= 0.35) return 'precise';
    if (n >= 1.0)  return 'creative';
    return 'balanced';
  }
  function readActiveTemperature() {
    // Don't forward a value the gateway will reject — even though we now
    // strip it server-side too, keeping the frontend honest avoids the
    // user seeing a slider value that the model is silently ignoring.
    if (!modelSupportsTemperature(els.modelPicker?.value)) return undefined;
    const id = state.activeChatId;
    if (id && state.perChatTemperature.has(id)) return state.perChatTemperature.get(id);
    if (els.tempSlider) {
      const n = parseFloat(els.tempSlider.value);
      if (Number.isFinite(n)) return n;
    }
    return 0.7;
  }
  function setTempUI(v) {
    const n = Math.max(0, Math.min(1.5, Number(v) || 0));
    if (els.tempSlider) els.tempSlider.value = String(n);
    if (els.tempValue)  els.tempValue.textContent = n.toFixed(2);
    if (els.tempPreset) els.tempPreset.dataset.state = tempStateForValue(n);
    if (els.tempPreset) els.tempPreset.textContent  = tempStateForValue(n);
  }
  function applyTemperatureForChat(chatId) {
    const fromMap = state.perChatTemperature.get(chatId);
    const fromRec = (state.chats.find(c => c.id === chatId) || {}).temperature;
    const v = (typeof fromMap === 'number') ? fromMap
            : (typeof fromRec === 'number') ? fromRec
            : 0.7;
    setTempUI(v);
    state.perChatTemperature.set(chatId, v);
    refreshTempUiForModel();
  }

  /** Disable the temperature picker when the active model rejects the
   *  parameter (Claude Opus 4.7+, GPT-5.5/5.4 — verified with curl).
   *  The slider stays visible so users learn the constraint instead of
   *  silently losing a control. */
  function modelSupportsTemperature(model) {
    const m = String(model || '').toLowerCase().replace(/^databricks-/, '');
    if (/^claude-(?:3|3-5|3-7)/.test(m)) return true;
    if (m.startsWith('claude-opus')) return false;
    if (m.startsWith('claude-sonnet-4-6')) return true;
    if (m.startsWith('claude-haiku-4-5'))  return true;
    if (m.startsWith('gpt-')) return /-mini\b/.test(m);
    return false;
  }
  function refreshTempUiForModel() {
    const model = els.modelPicker?.value || '';
    const ok = modelSupportsTemperature(model);
    const wrap = document.querySelector('.picker-temp');
    if (els.tempSlider) els.tempSlider.disabled = !ok;
    if (els.tempPreset) els.tempPreset.style.pointerEvents = ok ? '' : 'none';
    if (wrap) {
      wrap.classList.toggle('disabled', !ok);
      wrap.title = ok
        ? 'Temperature — 0 = deterministic (precise), 0.7 = balanced, 1.2+ = creative. Per-chat.'
        : `Temperature is not accepted by ${model || 'this model'}. Pick claude-sonnet-4-6, claude-haiku-4-5, or a gpt-*-mini model to use the slider.`;
    }
  }

  function bindUi() {
    bindSplitter();
    bindRailCollapse();
    bindRailSectionSplitter();
    bindThreadScroll();
    bindComposerResize();
    bindRailSectionToggles();
    // Recent sort dropdown — persist choice per window via localStorage.
    const sortSel = document.getElementById('recentSort');
    if (sortSel) {
      const saved = localStorage.getItem('auraStudio.recentSort');
      if (saved && ['updated','created','title'].includes(saved)) sortSel.value = saved;
      sortSel.onclick = (e) => e.stopPropagation();   // don't toggle the section
      sortSel.onchange = () => {
        localStorage.setItem('auraStudio.recentSort', sortSel.value);
        renderRecent();
      };
    }
    // Temperature slider (per-chat) — input updates the live UI + per-chat
    // map; chip click cycles through Precise/Balanced/Creative presets.
    if (els.tempSlider) {
      setTempUI(parseFloat(els.tempSlider.value) || 0.7);
      els.tempSlider.oninput = () => {
        const v = parseFloat(els.tempSlider.value);
        setTempUI(v);
        if (state.activeChatId) state.perChatTemperature.set(state.activeChatId, v);
      };
    }
    // Model picker — refresh the temperature picker enabled-state when
    // the user switches model (some models reject the temp param).
    if (els.modelPicker) {
      els.modelPicker.addEventListener('change', () => {
        refreshTempUiForModel();
        updateModelUnavailableButton();
        const opt = els.modelPicker.selectedOptions?.[0];
        const ctx = Number(opt?.dataset?.context || 0);
        if (ctx > 0) mergeContextUsage({ ctxMax: ctx, pct: (state.ctxUsage?.total || 0) / ctx });
        refreshContextUsage(els.modelPicker.value);
      });
      // First render, before any chat loads.
      refreshTempUiForModel();
      updateModelUnavailableButton();
    }
    if (els.modelUnavailableBtn) {
      els.modelUnavailableBtn.onclick = () => toggleSelectedModelUnavailable().catch(e => console.warn('[studio] set model unavailable failed:', e));
    }
    if (els.tempPreset) {
      els.tempPreset.onclick = () => {
        const cur = readActiveTemperature();
        const idx = TEMP_PRESETS.findIndex(p => Math.abs(p.value - cur) < 0.05);
        const next = TEMP_PRESETS[(idx + 1 + TEMP_PRESETS.length) % TEMP_PRESETS.length];
        setTempUI(next.value);
        if (state.activeChatId) state.perChatTemperature.set(state.activeChatId, next.value);
      };
    }

    bindProjectViewUi();
    els.modeResearch?.addEventListener('click', (e) => { e.preventDefault(); setMainMode('research'); });
    els.modeCoding?.addEventListener('click', (e) => { e.preventDefault(); setMainMode('coding'); });
    els.workspaceSplitToggle?.addEventListener('click', (e) => { e.preventDefault(); setWorkspaceSplit(!state.workspaceSplit); });
    els.workspaceLayoutPicker?.addEventListener('change', () => setWorkspaceLayout(els.workspaceLayoutPicker.value));
    els.terminalRefreshBtn?.addEventListener('click', () => terminalRefreshSessions().catch(terminalShowError));
    els.terminalNewBtn?.addEventListener('click', async () => {
      try { await terminalCreateAndOpen(); } catch (e) { terminalShowError(e); }
    });
    bindTerminalSplitter();
    bindWorkspaceSplitter();
    els.terminalSessions?.addEventListener('click', (e) => {
      const close = e.target.closest?.('.terminal-tab-close');
      if (close?.dataset.closeTarget) {
        e.preventDefault();
        e.stopPropagation();
        try { terminalCloseTarget(JSON.parse(close.dataset.closeTarget)).catch(terminalShowError); } catch {}
        return;
      }
      const btn = e.target.closest?.('.terminal-tab');
      if (!btn?.dataset.target) return;
      try { terminalOpenTarget(JSON.parse(btn.dataset.target)).catch(terminalShowError); } catch {}
    });
    els.terminalCloseBtn?.addEventListener('click', () => {
      if (state.terminal.ptyId) rpc('terminal.ptyClose', { id: state.terminal.ptyId }).catch(() => {});
      state.terminal.ptyId = null;
      state.terminal.term?.reset?.();
    });
    els.settingsBtn.onclick   = () => toggleSettings(true);
    if (els.layoutWidthToggle) els.layoutWidthToggle.onclick = () => {
      const next = !document.body.classList.contains('readable-width');
      localStorage.setItem('auraStudio.readableWidth', next ? '1' : '0');
      applyReadableWidth(next);
    };
    if (els.fontStylePicker) els.fontStylePicker.onchange = () => {
      localStorage.setItem('auraStudio.fontStyle', els.fontStylePicker.value);
      applyFontStyle(els.fontStylePicker.value);
    };
    els.topGearBtn.onclick    = () => toggleSettings(true);
    els.settingsBack.onclick  = () => toggleSettings(false);
    if (els.topExportBtn) els.topExportBtn.onclick = exportActiveChatAsMarkdown;
    if (els.topExportHtmlBtn) els.topExportHtmlBtn.onclick = exportActiveChatAsHtml;
    // v0.4.253 — remove any legacy regex-guessed cards that may have been
    // persisted in the webview panel state from an older extension build.
    purgeLegacyGhostCards();
    // v0.4.256 — panel state restore can land AFTER bindUi(); observe the
    // whole document body so late-arriving restored nodes are caught too.
    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => purgeLegacyGhostCards());
      mo.observe(document.body, { childList: true, subtree: true });
      // Also re-sweep a few times over the first 2s in case restore happens
      // in a batch after initial paint.
      setTimeout(purgeLegacyGhostCards, 100);
      setTimeout(purgeLegacyGhostCards, 500);
      setTimeout(purgeLegacyGhostCards, 2000);
    }
    if (els.topCompactBtn) els.topCompactBtn.onclick = compactActiveChat;
    if (els.topSpBtn) els.topSpBtn.onclick = () => {
      // Jump straight to Settings → System Prompt → Per-chat tab.
      toggleSettings(true);
      const btn = document.querySelector('.sp-tab[data-tier="chat"]');
      if (btn) btn.click();
    };

    document.querySelectorAll('.theme-tile').forEach(tile => {
      tile.onclick = async () => {
        const name = tile.dataset.theme;
        setTheme(name);
        await rpc('settings.set', { key: 'theme', value: name });
      };
    });

    els.newProjectBtn.onclick = async () => {
      const name = await showInputModal('Project name:', '');
      if (!name) return;
      const p = await rpc('projects.create', { name });
      state.activeProjectId = p.id;
      renderProjects();
    };

    els.newChatBtn.onclick = async () => {
      // 0.4.185 — the "New Chat" button always creates an Orphan chat.
      // Prior versions passed state.activeProjectId here, so clicking
      // "New Chat" while a project was selected in the rail (or while
      // viewing a project page) silently attached the fresh chat to that
      // project — the projectLabel header then correctly rendered its
      // name (e.g. "The VOID"), which the user reported as a bug because
      // the tooltip on projectLabel already promises "Chats created from
      // 'New Chat' are Orphan". Chats belonging to a project are created
      // from that project's page instead, via the composer inside it.
      const c = await rpc('chats.create', {
        projectId:   '',
        model:       els.modelPicker.value,
        temperature: readActiveTemperature(),
      });
      // If we were inside a Project page or Coding mode, leave it before showing
      // the new chat so the user lands directly in the conversation thread.
      if (state.view === 'project') leaveProjectView();
      if (state.mainMode === 'coding' && !state.workspaceSplit) setMainMode('research');
      await loadChat(c.id);
    };

    els.projectList.onclick = async (e) => {
      // Rename / delete pencil + X take priority over the row click.
      const renBtn = e.target.closest('button[data-act="renameProject"]');
      if (renBtn) {
        e.stopPropagation();
        await projectRenameFlow(renBtn.dataset.id);
        return;
      }
      const delBtn = e.target.closest('button[data-act="deleteProject"]');
      if (delBtn) {
        e.stopPropagation();
        await projectDeleteFlow(delBtn.dataset.id);
        return;
      }
      const li = e.target.closest('li[data-act="selectProject"]');
      if (!li) return;
      state.activeProjectId = li.dataset.id;
      renderProjects();
      // Issue #3: clicking a project row opens its dedicated page
      // (description editor + chat list). User can come back via "← Back".
      enterProjectView(li.dataset.id);
    };
    els.recentList.onclick = async (e) => {
      // Select-mode: clicking the row toggles the checkbox, not opens chat.
      if (state.recentSelectMode) {
        const liSel = e.target.closest('li[data-act="toggleSelect"]');
        if (!liSel) return;
        const id = liSel.dataset.id;
        if (state.recentSelectedIds.has(id)) state.recentSelectedIds.delete(id);
        else state.recentSelectedIds.add(id);
        renderRecent();
        return;
      }
      // Row actions take priority — don't open the chat while acting on it.
      const renChatBtn = e.target.closest('button[data-act="renameChat"]');
      if (renChatBtn) {
        e.stopPropagation();
        await chatRenameFlow(renChatBtn.dataset.id);
        return;
      }
      const delBtn = e.target.closest('button[data-act="deleteChat"]');
      if (delBtn) {
        e.stopPropagation();
        await deleteChatFlow(delBtn.dataset.id);
        return;
      }
      const li = e.target.closest('li[data-act="selectChat"]');
      if (!li) return;
      loadChat(li.dataset.id);
    };
    if (els.recentSelectToggle) {
      els.recentSelectToggle.onclick = () => setRecentSelectMode(!state.recentSelectMode);
    }
    if (els.recentSelectAll) {
      els.recentSelectAll.onclick = () => {
        for (const c of state.chats) state.recentSelectedIds.add(c.id);
        renderRecent();
      };
    }
    if (els.recentSelectCancel) {
      els.recentSelectCancel.onclick = () => setRecentSelectMode(false);
    }
    if (els.recentSelectDelete) {
      els.recentSelectDelete.onclick = async () => {
        const ids = [...state.recentSelectedIds];
        if (!ids.length) return;
        const n = await deleteChatsFlow(ids);
        if (n) setRecentSelectMode(false);
      };
    }

    // Global delegate: download button + thinking toggle + per-turn delete.
    els.threadInner.addEventListener('click', async (e) => {
      // 0.4.58 — explicit Zoom button on an SVG card opens the lightbox
      // (the SVG body itself stays selectable for copy/inspect).
      const zoomBtn = e.target.closest('[data-act="zoomSvg"]');
      if (zoomBtn) {
        e.preventDefault();
        e.stopPropagation();
        // `closest('.blk-svg-card')` already scopes to the card the user
        // clicked — not "the first card in the thread". Each ```svg fence
        // renders as its own card → its own stage → its own <svg>, so this
        // can never cross cards.
        const card = zoomBtn.closest('.blk-svg-card');
        // 0.4.62 — direct child of the stage. Avoids the magnifier icon
        // <svg> inside the zoom button itself, and ignores any nested
        // <svg> (e.g. inline icons inside the diagram) just in case.
        const svg  = card?.querySelector('.blk-svg-stage > svg');
        if (svg) {
          // 0.4.59 — open lightbox with an inline SVG clone (avoids the
          // data-URL <img> broken-image case user reported in 0.4.58).
          openSvgLightbox(svg, 'diagram.svg');
        }
        return;
      }
      const mermaidInlineZoomBtn = e.target.closest('[data-act="mermaidZoomIn"], [data-act="mermaidZoomOut"], [data-act="mermaidZoomReset"]');
      if (mermaidInlineZoomBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = mermaidInlineZoomBtn.closest('.md-mermaid');
        const canvas = card?.querySelector('.md-mermaid-canvas');
        const pct = card?.querySelector('[data-mermaid-pct]');
        if (canvas) {
          let z = Number(card.dataset.zoom || 1) || 1;
          const act = mermaidInlineZoomBtn.dataset.act;
          if (act === 'mermaidZoomIn') z *= 1.2;
          else if (act === 'mermaidZoomOut') z /= 1.2;
          else z = 1;
          z = Math.max(0.35, Math.min(6, z));
          card.dataset.zoom = String(z);
          canvas.style.transform = `scale(${z})`;
          if (pct) pct.textContent = `${Math.round(z * 100)}%`;
        }
        return;
      }
      const mermaidZoomBtn = e.target.closest('[data-act="zoomMermaid"]');
      if (mermaidZoomBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = mermaidZoomBtn.closest('.md-mermaid');
        const svg = card?.querySelector('.md-mermaid-stage svg');
        if (svg) openSvgLightbox(svg, 'flowchart.svg');
        return;
      }
      const mermaidCard = e.target.closest('.md-mermaid-stage');
      if (mermaidCard) {
        const svg = mermaidCard.querySelector('svg');
        if (svg) {
          e.preventDefault();
          e.stopPropagation();
          openSvgLightbox(svg, 'flowchart.svg');
          return;
        }
      }
      const artZoomBtn = e.target.closest('[data-act="zoomArtSvg"]');
      if (artZoomBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = artZoomBtn.closest('.art-svg');
        const svg = card?.querySelector(':scope > svg');
        if (svg) openSvgLightbox(svg, 'excalidraw-board.svg');
        return;
      }
      // 0.4.29/0.4.39 — clicking a regular image card opens the lightbox.
      // SVG cards (`.blk-svg-card`) deliberately do NOT — they're live
      // DOM the user should be able to SELECT, COPY, INSPECT in place,
      // the same way Claude.ai treats its visualiser output.
      const figCard = e.target.closest('.blk-image-card');
      if (figCard
          && !figCard.classList.contains('blk-svg-card')
          && !e.target.closest('[data-act="downloadImage"]')
          && !e.target.closest('details, summary')) {
        const inner = figCard.querySelector('img');
        if (inner && inner.src && inner.complete) {
          e.preventDefault();
          openImageLightbox(inner.src, inner.alt || '');
          return;
        }
      }
      // 1. Download image button on .blk-image-card
      const dlBtn = e.target.closest('[data-act="downloadImage"]');
      if (dlBtn) {
        const p = dlBtn.getAttribute('data-img-path');
        if (!p) return;
        const prev = dlBtn.textContent;
        dlBtn.disabled = true; dlBtn.textContent = '… saving';
        try {
          const r = await saveAsDownload({ path: p });
          if (r?.error) dlBtn.textContent = `✗ ${r.error.slice(0, 24)}`;
          else dlBtn.textContent = '✓ saved';
        } catch (err) {
          dlBtn.textContent = `✗ ${err.message.slice(0, 24)}`;
        } finally {
          setTimeout(() => { dlBtn.disabled = false; dlBtn.textContent = prev; }, 2000);
        }
        return;
      }
      // 2. Toggle inline thinking expand/collapse
      const tToggle = e.target.closest('[data-act="toggleThinking"]');
      if (tToggle) {
        const wrap = tToggle.closest('.blk-thinking-inline');
        if (!wrap) return;
        const collapsed = wrap.getAttribute('data-collapsed') === '1';
        wrap.setAttribute('data-collapsed', collapsed ? '0' : '1');
        return;
      }
      // 3. Per-turn delete (✕ button on a settled message bubble)
      const agentDel = e.target.closest('[data-act="deleteAgentMessage"]');
      if (agentDel) {
        const ok = await showConfirmModal(
          'Delete this sub-agent message?',
          'Only this message will be removed from the sub-agent history and runtime.',
          { okText: 'Delete', danger: true });
        if (!ok) return;
        await rpc('agents.deleteMessage', {
          chatId: state.activeChatId,
          agentId: agentDel.getAttribute('data-agent-id'),
          absIndex: Number(agentDel.getAttribute('data-turn-id')),
        });
        await openAgentThread(agentDel.getAttribute('data-agent-id'));
        return;
      }
      const turnDel = e.target.closest('[data-act="deleteTurn"]');
      if (turnDel) {
        const turnId = turnDel.getAttribute('data-turn-id');
        await deleteTurnFlow(turnId, turnDel.closest('.msg'));
        return;
      }
      // 4. Download attachment from tool result (file.saveAs)
      const fileBtn = e.target.closest('[data-act="downloadFile"]');
      if (fileBtn) {
        const p = fileBtn.getAttribute('data-file-path');
        if (!p) return;
        const prev = fileBtn.textContent;
        fileBtn.disabled = true; fileBtn.textContent = '… saving';
        try {
          const r = await saveAsDownload({ path: p });
          if (r?.error) fileBtn.textContent = `✗ ${r.error.slice(0, 24)}`;
          else           fileBtn.textContent = '✓ saved';
        } catch (err) {
          fileBtn.textContent = `✗ ${err.message.slice(0, 24)}`;
        } finally {
          setTimeout(() => { fileBtn.disabled = false; fileBtn.textContent = prev; }, 2000);
        }
        return;
      }
      // 5. Preview a generated file in the artifact panel.
      //    For text/code → render in <pre>. For docx/xlsx/pdf → ask host to
      //    convert to HTML preview (file.preview RPC). Falls back to
      //    "(no preview available)" with a download link.
      const prevBtn = e.target.closest('[data-act="previewFile"]');
      if (prevBtn) {
        const p = prevBtn.getAttribute('data-file-path');
        if (!p) return;
        prevBtn.disabled = true;
        const orig = prevBtn.textContent;
        prevBtn.textContent = '… loading';
        try {
          const r = await rpc('file.preview', { path: p });
          if (r?.error) prevBtn.textContent = `✗ ${r.error.slice(0, 24)}`;
          else {
            const filename = p.split(/[\\/]/).pop();
            const artId = addArtifact({
              kind: r.kind || 'text',
              title: filename,
              source: r.source || r.html || r.text || '',
              path: p,
              data: r.data, text: r.text, lang: r.lang, delimiter: r.delimiter, filename: r.filename,
            });
            try { selectArtifact(artId); } catch {}
            openArtifactPanel();
            prevBtn.textContent = '✓ open';
          }
        } catch (err) {
          prevBtn.textContent = `✗ ${err.message.slice(0, 24)}`;
        } finally {
          setTimeout(() => { prevBtn.disabled = false; prevBtn.textContent = orig; }, 1800);
        }
        return;
      }
    });

    els.composerInput.addEventListener('input', autoGrow);
    document.addEventListener('keydown', (e) => {
      // ESC anywhere → close the topmost overlay (settings has higher z; project under).
      if (e.key === 'Escape') {
        if (!els.settings.hidden) { toggleSettings(false); return; }
        if (els.projectView && !els.projectView.hidden) { leaveProjectView(); return; }
        // No overlay open: Esc stops the active stream if one's running.
        // (#7 in 0.2.18 — restore the keyboard hold/pause behaviour.)
        if (state.activeChatId && state.streamingChats.has(state.activeChatId)) {
          stopActiveChat();
          return;
        }
      }
      // Ctrl/Cmd + End → jump to the bottom of the current thread (#7).
      // Useful while watching a long stream; lets the user scroll back to
      // re-read something and snap back to live with one keystroke.
      if (e.key === 'End' && (e.ctrlKey || e.metaKey)) {
        if (state.view === 'chat' && !isEditableTarget(e.target)) {
          e.preventDefault();
          scrollThreadToEnd();
        }
      }
    });
    els.composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    // Paste image from clipboard (Win/Mac/Linux screenshot, GIMP "Edit > Copy",
    // browser image right-click → Copy image, etc.). We hand the bytes to
    // attach.add so the host caches them under <dataRoot>/chat-attachments/
    // — the same path the file-picker route uses. No native dialogs required.
    //
    // #5 in 0.2.18 — the previous implementation used
    // `btoa(String.fromCharCode(...new Uint8Array(buf)))`, which call-spreads
    // every byte of the image as a function argument. A typical screenshot
    // is ~500KB+; spreading hits "Maximum call stack size exceeded" before
    // btoa runs and silently bails — UX-wise: paste appears to do nothing.
    // Switch to FileReader.readAsDataURL which handles arbitrary-sized blobs.
    async function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload  = () => {
          const url = String(fr.result || '');
          const i = url.indexOf(',');
          resolve(i >= 0 ? url.slice(i + 1) : '');
        };
        fr.onerror = () => reject(fr.error || new Error('FileReader error'));
        fr.readAsDataURL(blob);
      });
    }
    // Bind paste on BOTH the textarea AND the document so a paste while the
    // composer isn't focused (user copied a screenshot, then clicked the
    // chat thread to look at history, then ⌘V) still attaches.
    //
    // Mirror ingestFile's chip-then-replace flow so the user sees an
    // optimistic "parsing…" chip immediately on ⌘V and a finalized chip
    // (thumbnail + filename) once the host has hashed and cached the bytes.
    // Earlier this branch called a non-existent renderAttachStrip(), which
    // threw silently inside try/catch — image was sent on Enter but the
    // input area showed no preview.
    async function handlePasteEvent(e) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === 'file' && /^image\//.test(it.type)) {
          const blob = it.getAsFile();
          if (!blob) continue;
          e.preventDefault();
          const ext = (blob.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
          const name = 'pasted-' + Date.now() + '.' + ext;

          // Optimistic chip — same UX as ingestFile.
          const tmpId = 'tmp-' + Math.random().toString(36).slice(2, 8);
          const chip = makeChip({ id: tmpId, filename: name, sizeBytes: blob.size, parsing: true });
          $('#attachStrip').appendChild(chip);

          try {
            const b64 = await blobToBase64(blob);
            if (!b64) {
              chip.classList.add('error');
              chip.querySelector('.label').textContent = `${name} — empty clipboard image`;
              return;
            }
            const chatIdForAttach = await ensureChatIdForAttach();
            const result = await rpc('attach.add', { name, dataBase64: b64, chatId: chatIdForAttach });
            if (!result || result.error) {
              chip.classList.add('error');
              chip.querySelector('.label').textContent = `${name} — ${result?.error || 'attach failed'}`;
              return;
            }
            const finalChip = makeChip({ ...result, id: result.hash });
            chip.replaceWith(finalChip);
            state.pendingAttachments.push(result);
          } catch (err) {
            chip.classList.add('error');
            chip.querySelector('.label').textContent = `${name} — ${err.message}`;
            console.warn('[studio] paste failed:', err);
          }
          return;
        }
      }
    }
    els.composerInput.addEventListener('paste', handlePasteEvent);
    document.addEventListener('paste', (e) => {
      // Only handle if focus isn't already on the composer (it would have
      // fired the textarea handler) and the user is in chat view.
      if (state.view !== 'chat') return;
      if (document.activeElement === els.composerInput) return;
      handlePasteEvent(e);
    });
    // Single Send/Stop button: when streaming the SAME button cancels.
    els.sendBtn.onclick = () => {
      if (isActiveStreaming()) stopActiveChat();
      else sendMessage();
    };
    els.sendBtn.disabled = false;
  }

  /** User pressed Stop — abort the SSE stream + tool loop for this chat.
   *  Other chats keep streaming. Implemented by RPC; host destroys the
   *  underlying socket and broadcasts chat.done with stopReason='cancelled'. */
  async function stopActiveChat() {
    const id = state.activeChatId;
    if (!id || !state.streamingChats.has(id)) return;
    try { await rpc('chat.cancel', { chatId: id }); }
    catch (e) { console.warn('[studio] cancel failed:', e); }
  }

  async function showContextOverflowModal() {
    const u = state.ctxUsage || {};
    const used = u.total || 0, max = u.ctxMax || 0;
    const pct = max ? Math.round((used / max) * 100) : Math.round((state.lastContextPct || 0) * 100);
    return new Promise(resolve => {
      const ov = $('#modalOverlay'), title = $('#modalTitle'), msg = $('#modalMessage'), input = $('#modalInput');
      const ok = $('#modalOk'), cancel = $('#modalCancel');
      let sw = document.getElementById('modalSwitchModel');
      if (!sw) {
        sw = document.createElement('button');
        sw.id = 'modalSwitchModel';
        sw.className = 'ghost-btn';
        cancel.parentNode.insertBefore(sw, cancel);
      }
      title.textContent = 'Context window almost full';
      msg.hidden = false;
      msg.textContent = `${pct}% of the selected model context is used (${formatTok(used)} / ${formatTok(max)} tokens). Compact before sending, switch model, or cancel.`;
      input.hidden = true;
      ok.textContent = 'Compact and send';
      cancel.textContent = 'Cancel';
      sw.textContent = 'Switch model';
      sw.hidden = false;
      ov.hidden = false;
      const cleanup = (v) => {
        ov.hidden = true; input.hidden = false; msg.hidden = true; msg.textContent = '';
        ok.onclick = cancel.onclick = sw.onclick = null; sw.hidden = true;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup('cancel'); }
        if (e.key === 'Enter') { e.preventDefault(); cleanup('compact'); }
      };
      document.addEventListener('keydown', onKey, true);
      ok.onclick = () => cleanup('compact');
      sw.onclick = () => cleanup('switch');
      cancel.onclick = () => cleanup('cancel');
      setTimeout(() => ok.focus(), 0);
    });
  }

  function buildComposerPayloadTextAndAttachments() {
    const text = els.composerInput.value.trim();
    const imageAttachments = [];
    const docAttachments = [];
    for (const a of (state.pendingAttachments || [])) {
      if (a.mimeType && a.mimeType.startsWith('image/')) {
        imageAttachments.push({
          path: a.path, mimeType: a.mimeType, filename: a.filename,
          inlineHint: a.inlineHint, parsedMd: null,
          hash: a.hash, sizeBytes: a.sizeBytes,
          origPath: a.origPath, resultPath: a.resultPath,
        });
      } else {
        docAttachments.push({
          filename:   a.filename,
          hash:       a.hash,
          mimeType:   a.mimeType,
          sizeBytes:  a.sizeBytes,
          notes:      a.notes,
          resultPath: a.resultPath,
          origPath:   a.origPath,
        });
      }
    }
    return { text, imageAttachments, docAttachments, attachments: [...imageAttachments, ...docAttachments] };
  }

  async function offerQueueMessage() {
    const text = els.composerInput.value.trim();
    if (!text || !state.activeChatId) return;
    const ok = await showConfirmModal(
      'Queue message?',
      'Aether is still responding. Queue this message to run after the current response finishes? Use Stop/Esc or Cancel agent for immediate cancellation.',
      { okText: 'Queue', danger: false },
    );
    if (!ok) return;
    const payload = buildComposerPayloadTextAndAttachments();
    await rpc('chat.queueSend', {
      chatId: state.activeChatId,
      model: els.modelPicker.value,
      text: payload.text,
      attachments: payload.attachments,
      thinking: els.thinkingPicker?.value || 'off',
      temperature: readActiveTemperature(),
      developerMode: state.developerMode === true,
    });
    els.composerInput.value = '';
    autoGrow();
    state.pendingAttachments = [];
    $('#attachStrip').innerHTML = '';
  }

  function onChatQueued(payload) {
    const chatId = payload?.chatId;
    if (!chatId) return;
    if (!payload.text) state.queuedByChat.delete(chatId);
    else state.queuedByChat.set(chatId, payload);
    renderQueuedPill();
  }

  function renderQueuedPill() {
    document.getElementById('queuedMsgPill')?.remove();
    const queued = state.activeChatId ? state.queuedByChat.get(state.activeChatId) : null;
    if (!queued || !els.composer) return;
    const el = document.createElement('div');
    el.id = 'queuedMsgPill';
    el.className = 'queued-msg-pill';
    el.innerHTML = `<span class="qp-label">queued</span><span class="qp-text">${escapeHtml(String(queued.text || ''))}</span><button class="qp-cancel" title="Cancel queued message">×</button>`;
    el.querySelector('.qp-cancel')?.addEventListener('click', () => rpc('chat.dequeueMessage', { chatId: state.activeChatId }).catch(() => {}));
    const strip = $('#attachStrip');
    if (strip?.parentElement) strip.parentElement.insertBefore(el, strip);
    else els.composer.prepend(el);
  }

  function detectDocumentPathsForHybrid(text) {
    const found = [];
    const seen = new Set();
    const rx = /(^|[\s"'`(\[{<])((?:\/[\w .@%+=:,;~#-]+)+\.(?:pdf|docx?|pptx?|xlsx?))(?=$|[\s"'`),\]}>])/gi;
    let m;
    while ((m = rx.exec(String(text || '')))) {
      const p = m[2].trim();
      if (!seen.has(p)) { seen.add(p); found.push(p); }
    }
    return found;
  }

  async function attachTypedHybridPaths(text, chatId) {
    const paths = detectDocumentPathsForHybrid(text);
    if (!paths.length) return;
    const attached = new Set((state.pendingAttachments || []).map(a => a.origPath || a.path).filter(Boolean));
    for (const abs of paths) {
      if (attached.has(abs)) continue;
      const tmpId = 'tmp-' + Math.random().toString(36).slice(2, 8);
      const filename = abs.split(/[\\/]/).pop() || 'file';
      const chip = makeChip({ id: tmpId, filename, parsing: true, notes: 'hybrid parse' });
      $('#attachStrip').appendChild(chip);
      try {
        const r = await rpc('attach.addByPathHybrid', { path: abs, chatId });
        if (!r || r.error) {
          chip.classList.add('error');
          chip.querySelector('.label').textContent = `${filename} — ${(r && r.error) || 'attach failed'}`;
          continue;
        }
        const finalChip = makeChip({ ...r, id: r.hash });
        chip.replaceWith(finalChip);
        state.pendingAttachments.push(r);
        attached.add(r.origPath || r.path || abs);
      } catch (e) {
        chip.classList.add('error');
        chip.querySelector('.label').textContent = `${filename} — ${e.message}`;
      }
    }
  }

  /** Manual chat with a completed/terminal agent — uses agents.chat RPC.
   *  Streams via the same agent.chunk/tool/usage events; on completion reloads
   *  agents.turns to replace the live buffer with persisted bubbles. */
  async function sendAgentChat(text) {
    const chatId = state.activeChatId;
    const agentId = state.activeAgentId;
    if (!chatId || !agentId || !text) return;

    state.agentManualStreaming = true;
    refreshComposerButtons();
    if (els.agentSubmitBtn) els.agentSubmitBtn.disabled = true;

    // Optimistic user bubble
    const opt = appendTurnDom({ role: 'user', content: [{ type: 'text', text }] }, { agentId });
    if (opt?.wrap) opt.wrap.dataset.optimistic = '1';
    els.composerInput.value = '';
    autoGrow();
    scrollThreadToEnd();

    try {
      await rpc('agents.chat', { chatId, agentId, text });
    } catch (e) {
      console.warn('[studio] agents.chat failed:', e);
    } finally {
      state.agentManualStreaming = false;
      // Reload turns to replace live buffer with persisted bubbles
      if (state.activeChatId === chatId && state.activeAgentId === agentId) {
        const viewGen = state.agentViewGen;
        const turns = await rpc('agents.turns', { chatId, agentId }).catch(() => null);
        if (viewGen === state.agentViewGen && state.activeChatId === chatId && state.activeAgentId === agentId) {
          els.threadInner.innerHTML = '';
          let lastWasAsst = false;
          for (const turn of (Array.isArray(turns) ? turns : [])) {
            if (isToolResultTurn(turn) && lastWasAsst) {
              absorbToolResultIntoLast(turn);
              continue;
            }
            appendTurnDom(turn, { agentId });
            lastWasAsst = (turn.role === 'assistant');
          }
          clearAgentLiveBuffer(chatId, agentId);
          scrollThreadToEnd(true);
          // Refresh tree so result is updated
          const tree = await rpc('agents.tree', { chatId }).catch(() => null);
          if (tree?.agents) onAgentsSnapshot({ rootChatId: chatId, agents: tree.agents });
          updateAgentThreadBar();
        }
      }
      refreshComposerButtons();
    }
  }

  async function sendMessage() {
    const text = els.composerInput.value.trim();
    if (!text) return;

    // Agent thread chat — route to agents.chat RPC
    if (state.activeAgentId && state.activeChatId) {
      if (state.agentManualStreaming) return; // already streaming
      const agent = agentsForActiveChat().find(a => a.agentId === state.activeAgentId);
      const isTerminal = !agent || ['completed', 'released', 'limit_reached', 'error', 'cancelled'].includes(agent?.status);
      if (isTerminal) {
        await sendAgentChat(text);
        return;
      }
    }

    // Per-chat streaming: only block sending if THIS chat is mid-stream.
    if (state.activeChatId && state.streamingChats.has(state.activeChatId)) {
      offerQueueMessage().catch(e => console.warn('[studio] queue message failed:', e));
      return;
    }

    // 0.4.184 — block send while any attach chip is still parsing. Prior
    // versions sent the message with `state.pendingAttachments` still empty
    // (chip finalizes → push only happens after MinerU returns), so the
    // model saw the text without the file. Now we wait until the chip
    // flips off `.parsing` before shipping.
    // 0.4.185 — exclude .error chips: attach.addByPath / attach.add error
    // paths add `.error` but never remove `.parsing`, so the chip carried
    // both classes; the hint kept firing on failed attachments and blocked
    // send forever. `.attach-chip.parsing:not(.error)` targets only chips
    // that are genuinely mid-parse.
    // 0.4.186 — first Send while parsing shows the hint; if the user Sends
    // again within 4s, we honour it — Send-anyway — and ship the text with
    // whatever pendingAttachments have already resolved. This is the escape
    // hatch when MinerU REMOTE is hung / down and the chip will never flip.
    const parsingChips = $('#attachStrip').querySelectorAll('.attach-chip.parsing:not(.error)');
    if (parsingChips.length) {
      const now = Date.now();
      const lastNudge = state._parseSendNudgeAt || 0;
      if (now - lastNudge < 4000) {
        state._parseSendNudgeAt = 0;
        // fall through — send with whatever the user has now
      } else {
        state._parseSendNudgeAt = now;
        const strip = $('#attachStrip');
        if (strip && !strip.querySelector('.parse-wait-hint')) {
          const flash = document.createElement('div');
          flash.className = 'muted small parse-wait-hint';
          flash.style.cssText = 'padding:4px 8px;color:var(--accent);';
          flash.textContent = `⏳ ${parsingChips.length} attachment${parsingChips.length > 1 ? 's are' : ' is'} still parsing (MinerU). Wait for the chip's spinner to stop — or press Send again within 4s to ship the text WITHOUT the file (escape hatch when MinerU is hung).`;
          strip.parentElement?.insertBefore(flash, strip);
          setTimeout(() => flash.remove(), 4000);
        }
        return;
      }
    }

    setEmptyChatMode(false);

    // ensure a chat exists
    let chatId = state.activeChatId;
    if (!chatId) {
      // 0.4.190 — auto-create chats should be Orphan by default. Only
      // assign to a project when the user is INSIDE that project's page
      // (state.view === 'project'). `state.activeProjectId` is set to
      // the first rail entry on boot, which was silently sinking every
      // sent-without-clicking-New-Chat message into "The VOID".
      const autoProjectId = (state.view === 'project' && state.activeProjectId)
        ? state.activeProjectId
        : '';
      const c = await rpc('chats.create', {
        projectId:   autoProjectId,
        model:       els.modelPicker.value,
        temperature: readActiveTemperature(),
      });
      chatId = c.id;
      state.activeChatId = chatId;
      state.chats.unshift(c);
      refreshProjectLabel();
      applyTemperatureForChat(chatId);
    }

    await attachTypedHybridPaths(text, chatId);

    if ((state.ctxUsage?.pct || state.lastContextPct || 0) >= 0.95 || (state.ctxUsage?.ctxMax && state.ctxUsage?.total > state.ctxUsage.ctxMax)) {
      const choice = await showContextOverflowModal();
      if (choice === 'cancel') return;
      if (choice === 'switch') { els.modelPicker?.focus(); return; }
      if (choice === 'compact') {
        const r = await rpc('chats.compact', { chatId });
        if (!r || r.ok === false) {
          console.warn('[studio] overflow compact failed; message not sent', r);
          await showConfirmModal('Compact failed', 'Aether could not compact this chat, so the message was not sent. Try switching to a larger model or compact again.', { okText: 'OK', danger: false });
          return;
        }
        await refreshContextUsage();
      }
    }

    // 0.4.189 — send images as vision blocks and doc attachments as
    // {hash, resultPath} metadata; the backend inlines a path reference
    // into the prompt (see ChatPanelV2 sendMessage augmented builder).
    // Prior versions inlined parsedMd here on the client side. That
    // dumped the full markdown into the message the user visually
    // "typed", bloating both the prompt and the JSONL user turn.
    const augmented = text;
    const imageAttachments = [];
    const docAttachments = [];
    for (const a of (state.pendingAttachments || [])) {
      if (a.mimeType && a.mimeType.startsWith('image/')) {
        imageAttachments.push({
          path: a.path, mimeType: a.mimeType, filename: a.filename,
          inlineHint: a.inlineHint, parsedMd: null,
          hash: a.hash, sizeBytes: a.sizeBytes,
          origPath: a.origPath, resultPath: a.resultPath,
        });
      } else {
        docAttachments.push({
          filename:   a.filename,
          hash:       a.hash,
          mimeType:   a.mimeType,
          sizeBytes:  a.sizeBytes,
          notes:      a.notes,
          resultPath: a.resultPath,
          origPath:   a.origPath,
        });
      }
    }

    setEmptyChatMode(false);

    // optimistic user bubble — text + thumbnails for image attachments.
    // Mark with data-optimistic so the host's chat.userTurn broadcast can
    // promote it to a real persisted turn (assigning data-turn-id).
    // Without this, appendMissingTurns() pulls the persisted user turn from
    // DB and re-renders it → duplicated user bubble.
    const optimisticBlocks = [{ type: 'text', text }];
    const opt = appendTurnDom({ role: 'user', content: optimisticBlocks });
    if (opt?.wrap) opt.wrap.dataset.optimistic = '1';
    // 0.4.188 — render a chip row for ALL attachments (not just images) so
    // the user bubble reflects what actually shipped. Previously only image
    // thumbnails were prepended; PDFs/DOCX went into the augmented prompt
    // silently, so the user's own bubble showed just their text and there
    // was no visible confirmation the file was attached.
    const bubbleChips = [];
    for (const a of imageAttachments) {
      bubbleChips.push(`<span class="msg-image-chip">🖼️ ${escapeHtml(a.filename)}</span>`);
    }
    for (const a of (state.pendingAttachments || [])) {
      if (a.mimeType && a.mimeType.startsWith('image/')) continue; // already added
      const label = `${escapeHtml(a.filename || 'file')}${a.sizeBytes ? ` <span class="muted small">${formatSize(a.sizeBytes)}</span>` : ''}${a.notes ? ` <span class="muted small">· ${escapeHtml(a.notes)}</span>` : ''}`;
      bubbleChips.push(`<span class="msg-image-chip">📎 ${label}</span>`);
    }
    if (bubbleChips.length) {
      const lastBubble = els.threadInner.lastElementChild;
      const chipRow = document.createElement('div');
      chipRow.className = 'msg-image-row';
      chipRow.innerHTML = bubbleChips.join('');
      lastBubble.querySelector('.msg-body').prepend(chipRow);
    }
    els.composerInput.value = '';
    autoGrow();
    scrollThreadToEnd();

    state.pendingAttachments = [];
    $('#attachStrip').innerHTML = '';

    // Capture chatId in closure so the error handler routes to the right
    // pendingAsst even if the user has switched chats meanwhile.
    const sendChatId = chatId;
    // 0.4.52 — optimistic streaming flag so the composer button flips to
    // Stop the instant the user hits send. Backend's chat.streaming
    // broadcast arrives asynchronously, sometimes only after first SSE
    // byte (~3-7s on Opus + max thinking). Without this, the user sees
    // only the ↑ icon during the long wait and can't cancel.
    state.streamingChats.add(sendChatId);
    if (sendChatId === state.activeChatId) refreshComposerButtons();
    rpc('chat.send', {
      chatId, model: els.modelPicker.value, text: augmented,
      // 0.4.189 — send both image + doc attachment metadata so the
      // backend can persist them alongside the user turn and swap in
      // the parsed-file path reference at prompt-build time.
      attachments: [...imageAttachments, ...docAttachments],
      thinking: els.thinkingPicker?.value || 'off',
      temperature: readActiveTemperature(),
      // v0.2.16 — Developer Mode flag. Off by default; the user has to
      // explicitly press 🛡️ in the composer for the host to drop the
      // sandbox on this send.
      developerMode: state.developerMode === true,
    })
      .then(r => { if (r && r.error) onChatError({ chatId: sendChatId, error: r.error }); })
      .catch(err => onChatError({ chatId: sendChatId, error: err.message }));
  }

  function promptDisplayText(v) {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    // RPC payload shape: prefer the canonical `value` field, then fall
    // back to other string-bearing keys the host has shipped over time.
    if (typeof v === 'object') {
      if (typeof v.value   === 'string') return v.value;
      if (typeof v.system  === 'string') return v.system;
      if (typeof v.content === 'string') return v.content;
      if (typeof v.text    === 'string') return v.text;
      // Last-resort fallback — never let "[object Object]" reach the DOM
      // (the historic 0.4.13 bug where a raw object hit a <textarea>).
      try { return JSON.stringify(v, null, 2); }
      catch { return ''; }
    }
    return String(v);
  }

  function toggleSettings(open) {
    els.settings.hidden = !open;
    // settings.css uses position:absolute + z-index:10 to overlay; we just toggle hidden.
    // Make ABSOLUTELY sure main is interactive after closing — browsers can leave stale
    // pointer-events / visibility from older builds, so we reset both explicitly.
    els.main.style.visibility = '';
    els.main.style.pointerEvents = '';
    if (open) {
      // 0.4.9 — always (re)load pricing + system prompt when settings is
      // shown. The bindings on the buttons themselves only fire on click,
      // not when the panel is opened by other paths (Esc, programmatic
      // jumps), so a fresh open could land on an empty pricing table.
      try { settingsLoadAll(); } catch (e) { console.warn('[studio] settingsLoadAll:', e); }
    } else {
      // Force focus back to composer so Enter works immediately.
      try { els.composerInput.focus(); } catch {}
    }
  }

  /* ── Project View (Issue #3) ─────────────────────────────────────
   * Clicking a project in the rail enters this page:
   *   • textarea bound to project.systemPrompt — saves on click
   *   • list of chats inside the project + "+ New chat" button
   *   • "← Back" returns to the previous chat thread
   * Each project has its own description; switching projects swaps it,
   * never merges. The description is the project-tier system prompt that
   * gets prepended to every chat in that project.
   */
  let _projectDescDirtyFor = null;
  async function enterProjectView(projectId) {
    if (!projectId) return;
    const proj = state.projects.find(p => p.id === projectId);
    if (!proj) return;
    state.view = 'project';
    state.activeProjectId = projectId;
    els.projectTitle.textContent = proj.name;
    // Load description (project-tier system prompt)
    let desc = '';
    try { desc = promptDisplayText(await rpc('systemPrompt.get', { tier: 'project', projectId })); }
    catch { desc = ''; }
    els.projectDescEditor.value = desc;
    els.projectDescStatus.textContent = '';
    _projectDescDirtyFor = projectId;
    // Load chats in project
    let chats = [];
    try { chats = await rpc('chats.listByProject', { projectId }); } catch { chats = []; }
    renderProjectChatList(chats);
    // Show
    els.projectView.hidden = false;
  }

  function leaveProjectView() {
    state.view = 'chat';
    els.projectView.hidden = true;
    try { els.composerInput.focus(); } catch {}
  }

  function renderProjectChatList(chats) {
    state.projectChatsCache = chats || [];
    const sel = state.projectChatSelectMode;
    if (!chats.length) {
      els.projectChatList.innerHTML = '<li class="pc-empty">No chats yet. Click ＋ New chat above.</li>';
      els.projectChatSelectBar.hidden = true;
      return;
    }
    els.projectChatList.innerHTML = chats.map(c => {
      const when    = new Date(c.updatedAt).toLocaleString();
      const checked = state.projectChatSelectedIds.has(c.id);
      const cb = sel
        ? `<input type="checkbox" class="rail-check" data-act="togglePcSelect" data-id="${c.id}" ${checked ? 'checked' : ''}>`
        : '';
      return `<li data-id="${c.id}" ${checked ? 'class="is-selected"' : ''}>
        ${cb}
        <span class="ico"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H2a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2v3l3-3h7a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z"/></svg></span>
        <span class="pc-title">${escapeHtml(c.title || 'Untitled')}</span>
        <span class="pc-meta">${escapeHtml(when)}</span>
        ${sel ? '' : `<span class="pc-actions">
          <button class="pc-del pc-ren" data-act="renameChat" data-id="${c.id}" title="Rename chat">✎</button>
          <button class="pc-del" data-act="deleteChat" data-id="${c.id}" title="Delete chat">✕</button>
        </span>`}
      </li>`;
    }).join('');
    els.projectChatSelectBar.hidden = !sel;
    updateProjectChatSelectBar();
    els.projectChatList.onclick = async (e) => {
      // checkbox toggle
      const cb = e.target.closest('input[data-act="togglePcSelect"]');
      if (cb) {
        e.stopPropagation();
        if (cb.checked) state.projectChatSelectedIds.add(cb.dataset.id);
        else            state.projectChatSelectedIds.delete(cb.dataset.id);
        updateProjectChatSelectBar();
        // re-render only the selected class, not the whole list (cheaper)
        const li = cb.closest('li[data-id]');
        if (li) li.classList.toggle('is-selected', cb.checked);
        return;
      }
      const renChatBtn = e.target.closest('button[data-act="renameChat"]');
      if (renChatBtn) {
        e.stopPropagation();
        await chatRenameFlow(renChatBtn.dataset.id);
        return;
      }
      const delBtn = e.target.closest('button[data-act="deleteChat"]');
      if (delBtn) {
        e.stopPropagation();
        await deleteChatFlow(delBtn.dataset.id);
        return;
      }
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      // In select mode, clicking a row toggles its checkbox instead of
      // navigating into the chat.
      if (state.projectChatSelectMode) {
        const id = li.dataset.id;
        const has = state.projectChatSelectedIds.has(id);
        if (has) state.projectChatSelectedIds.delete(id);
        else     state.projectChatSelectedIds.add(id);
        renderProjectChatList(state.projectChatsCache);
        return;
      }
      leaveProjectView();
      loadChat(li.dataset.id);
    };
  }

  function updateProjectChatSelectBar() {
    if (!els.projectChatSelCount) return;
    const n = state.projectChatSelectedIds.size;
    els.projectChatSelCount.textContent = `${n} selected`;
    els.projectChatSelectDelete.disabled = n === 0;
  }
  function setProjectChatSelectMode(on) {
    state.projectChatSelectMode = !!on;
    if (!on) state.projectChatSelectedIds.clear();
    renderProjectChatList(state.projectChatsCache);
  }

  function bindProjectViewUi() {
    if (!els.projectView) return;
    els.projectBack.onclick = leaveProjectView;
    els.projectDescSave.onclick = async () => {
      if (!_projectDescDirtyFor) return;
      try {
        await rpc('systemPrompt.set', {
          tier: 'project',
          projectId: _projectDescDirtyFor,
          value: els.projectDescEditor.value,
        });
        els.projectDescStatus.textContent = '✓ saved';
        setTimeout(() => { els.projectDescStatus.textContent = ''; }, 2000);
      } catch (e) {
        els.projectDescStatus.textContent = `✗ ${e.message}`;
      }
    };
    els.projectNewChat.onclick = async () => {
      // #3 in 0.2.18 — if a user clicked into a project page from a
      // freshly-loaded panel (state.activeProjectId already lost) the click
      // silently no-op'd. Refresh + warn so we never go quiet.
      if (!state.activeProjectId) {
        console.warn('[studio] projectNewChat: no active project, refreshing');
        await refreshProjects();
        if (!state.activeProjectId) return;
      }
      try {
        const c = await rpc('chats.create', {
          projectId:   state.activeProjectId,
          model:       els.modelPicker.value,
          temperature: readActiveTemperature(),
        });
        if (!c || !c.id) {
          console.warn('[studio] chats.create returned no id:', c);
          return;
        }
        leaveProjectView();
        await loadChat(c.id);
      } catch (e) {
        console.warn('[studio] chats.create failed:', e);
      }
    };
    els.projectRename.onclick = async () => {
      await projectRenameFlow(state.activeProjectId);
    };
    els.projectDelete.onclick = async () => {
      await projectDeleteFlow(state.activeProjectId);
    };
    // Multi-select toggle (issue #4 in 0.2.12 — same pattern as Recent rail)
    if (els.projectChatSelectToggle) {
      els.projectChatSelectToggle.onclick = () =>
        setProjectChatSelectMode(!state.projectChatSelectMode);
    }
    if (els.projectChatSelectAll) {
      els.projectChatSelectAll.onclick = () => {
        for (const c of state.projectChatsCache) state.projectChatSelectedIds.add(c.id);
        renderProjectChatList(state.projectChatsCache);
      };
    }
    if (els.projectChatSelectCancel) {
      els.projectChatSelectCancel.onclick = () => setProjectChatSelectMode(false);
    }
    if (els.projectChatSelectDelete) {
      els.projectChatSelectDelete.onclick = async () => {
        const ids = [...state.projectChatSelectedIds];
        if (!ids.length) return;
        const n = await deleteChatsFlow(ids);
        if (n) {
          setProjectChatSelectMode(false);
          // Reload list — host will broadcast invalidate but be eager.
          if (state.activeProjectId) {
            try {
              const chats = await rpc('chats.listByProject', { projectId: state.activeProjectId });
              renderProjectChatList(chats);
            } catch {}
          }
        }
      };
    }
  }
  function autoGrow() {
    const t = els.composerInput;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 240) + 'px';
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }


  /* ── tool exec status events (P5.4) ─────────────────────────────── */
  /**
   * On tool.start, paint a "running…" badge on the tool_use block in the
   * currently streaming bubble. On tool.done, the badge gets replaced when
   * appendMissingTurns inserts the persisted tool_result turn, but for
   * extra safety we also clear it explicitly here.
   */
  function onToolStart({ chatId, id, name }) {
    const a = state.pendingAsstByChat.get(chatId);
    if (chatId === state.activeChatId) setStreamStatus(a, 'Running', name);
    if (!a) return;
    const wrap = a.wrap;
    const blocks = wrap.querySelectorAll('.blk-tool-use');
    const last = blocks[blocks.length - 1];
    if (last && !last.dataset.running) {
      last.dataset.running = '1';
      last.dataset.toolId = id;
      const badge = document.createElement('span');
      badge.className = 'tool-status-badge';
      badge.textContent = 'running';
      const summary = last.querySelector('summary') || last;
      summary.appendChild(badge);
    }
  }
  function replayRememberedArtifactsForTool(chatId, toolUseId) {
    if (!chatId || !toolUseId) return;
    const artifacts = state.artifactsByChat.get(chatId) || [];
    for (const a of artifacts) {
      if (String(a?.toolUseId || '') !== String(toolUseId)) continue;
      onArtifactAttach({ ...a, chatId, live: a.live !== false });
    }
  }

  function onToolDone({ chatId, id, isError }) {
    const a = state.pendingAsstByChat.get(chatId);
    if (chatId === state.activeChatId) setStreamStatus(a, isError ? 'Tool failed' : 'Tool done — continuing…');
    if (a) {
      const wrap = a.wrap;
      wrap.querySelectorAll(`.blk-tool-use[data-tool-id="${id}"]`).forEach(el => {
        delete el.dataset.running;
        el.dataset.finished = isError ? 'error' : 'done';
      });
      wrap.querySelectorAll(`.blk-tool-use[data-tool-id="${id}"] .tool-status-badge`).forEach(el => {
        el.textContent = isError ? 'error' : 'done';
        el.classList.add(isError ? 'is-error' : 'is-done');
      });
    }
    // Sweep visible thread for older bubbles (only if user is on this chat).
    if (chatId === state.activeChatId) {
      els.threadInner.querySelectorAll(`.blk-tool-use[data-tool-id="${id}"]`).forEach(el => {
        delete el.dataset.running;
        el.dataset.finished = isError ? 'error' : 'done';
      });
      appendMissingTurns()
        .then(() => {
          replayRememberedArtifactsForTool(chatId, id);
          return rpc('chats.cachedArtifacts', { chatId });
        })
        .then(c => {
          injectCachedArtifacts(chatId, c || {});
          replayRememberedArtifactsForTool(chatId, id);
        })
        .catch(e => console.warn('[studio] tool hydrate failed:', e));
    }
  }

  /**
   * Pull only NEW persisted turns from the host and append them.
   *  - Skips turns we already rendered (tracked by data-turn-id on bubbles).
   *  - Tool-result turns get absorbed into the previous assistant bubble
   *    (or, during streaming, into the streaming bubble) so we keep the
   *    "one card per tool call" UX.
   * Idempotent: safe to call repeatedly during a tool loop.
   */
  async function appendMissingTurns() {
    if (!state.activeChatId || state.activeAgentId) return;
    const turns = await rpc('chats.turns', { chatId: state.activeChatId });

    // Build set of turn ids already in DOM.
    const seen = new Set();
    els.threadInner.querySelectorAll('.msg[data-turn-id]').forEach(el => {
      seen.add(String(el.dataset.turnId));
    });
    // Tool-result turns don't get their own data-turn-id — they're absorbed
    // into the previous assistant bubble's data-absorbed-ids. Walk every
    // bubble (streaming + settled) and pick those ids up too. Without this,
    // each subsequent tool.done re-injects ALL prior tool_result blocks
    // into the new streaming bubble (the "old file cards keep stacking" bug).
    els.threadInner.querySelectorAll('.msg[data-absorbed-ids]').forEach(el => {
      String(el.dataset.absorbedIds || '').split(',').forEach(id => {
        if (id) seen.add(String(id));
      });
    });

    // The streaming wrap is assigned its persisted turn-id by the host's
    // chat.asstTurn broadcast (see onAsstTurnId). That broadcast is reliable
    // because persistAssistant runs BEFORE tool.done. So at this point
    // any streaming wrap that already had its content persisted already has
    // dataset.turnId, and the seen-set above picked it up. (Earlier versions
    // tried a "claim newest assistant turn" heuristic here, but it
    // mis-assigned iter-0 turn-ids to iter-1 wraps when chat.asstTurn was
    // missing — broke layer2_toolLoopAppendsNotWipes.)

    for (const t of turns) {
      if (t.id !== undefined && seen.has(String(t.id))) continue;
      // 0.4.163 — synthetic user turns are already surfaced live via
      // chat.continuation.hint; skip them here so appendMissingTurns
      // doesn't materialise them as user bubbles after chat.done.
      // 0.4.241 — mirror the pattern-detect defence from the initial
      // replay so a hint whose synthetic flag was dropped still gets
      // skipped here instead of materialising as a user bubble.
      if (t.role === 'user') {
        const rawText = typeof t.content === 'string'
          ? t.content
          : (Array.isArray(t.content)
              ? t.content.map(b => (b && b.type === 'text' ? b.text : '')).join('')
              : '');
        const looksLikeHint =
          /^\(SYSTEM: your prior segment used the entire output budget/.test(rawText) ||
          /^\(continue — pick up where you left off/.test(rawText) ||
          /^\(continue — your last turn ended without an \[END\] marker/.test(rawText) ||
          rawText === '(continue)';
        if (t.synthetic || looksLikeHint) {
          if (t.id !== undefined) seen.add(String(t.id));
          continue;
        }
      }

      const stream = els.threadInner.querySelector('.msg.streaming');

      // 0.4.120 — a settled asst bubble whose data-turn-id broadcast
      // (chat.asstTurn) raced with chat.done leaves the wrap untagged.
      // On the next appendMissingTurns() the persisted turn's id is not
      // in `seen` and we clone the bubble under itself (screenshot 40 —
      // text renders twice, memcard sandwiched between). Instead: adopt
      // the existing live/recent bubble by tagging it with this turn's id.
      // 0.4.393 — don't restrict adoption to untagged bubbles. During a
      // visualise/tool loop, appendMissingTurns can run before the live DOM
      // has reconciled all tool artifacts; if an equivalent assistant bubble
      // is already visible, inserting the persisted turn gives the exact
      // pre-switch duplicate that disappears after reload. Match by leading
      // prose and treat the persisted turn as already rendered.
      if (!isToolResultTurn(t) && t.role === 'assistant' && t.id !== undefined) {
        const firstText = Array.isArray(t.content)
          ? (t.content.find(b => b && b.type === 'text')?.text || '').trim()
          : '';
        if (firstText) {
          const prefix = firstText.slice(0, 80);
          const bubbles = els.threadInner.querySelectorAll('.msg-assistant');
          for (const bubble of bubbles) {
            const txt = bubble.querySelector('.blk-text');
            if (txt && txt.textContent.trim().startsWith(prefix)) {
              if (!bubble.dataset.turnId) bubble.dataset.turnId = String(t.id);
              seen.add(String(t.id));
              break;
            }
          }
          if (seen.has(String(t.id))) continue;
        }
      }

      // Tool-result turn → merge into the bubble that emitted the
      // matching tool_use. ALWAYS prefer the tool_use_id-anchored bubble
      // over the streaming wrap — otherwise a late tool.done from turn N
      // gets sucked into turn N+1's streaming bubble and stacks orphan
      // cards on the wrong turn (the "Excel turn shows image card" bug).
      if (isToolResultTurn(t)) {
        const parent = findParentAssistantBubble(t);
        if (parent) {
          absorbToolResultIntoLast(t);
        } else if (stream) {
          stream.querySelector('.msg-body')?.classList.add('has-absorbed-tools');
          appendBlocksTo(stream.querySelector('.msg-body'), t.content);
          // Tag streaming bubble so refreshes don't re-add the same blocks.
          stream.dataset.absorbedIds = (stream.dataset.absorbedIds || '') + ',' + (t.id ?? '');
        } else {
          absorbToolResultIntoLast(t);
        }
        continue;
      }

      // Regular turn → new bubble. Insert before streaming so it stays last.
      if (stream) {
        const wrap = document.createElement('div');
        wrap.className = `msg msg-${t.role}`;
        if (t.id !== undefined) wrap.dataset.turnId = String(t.id);
        const body = document.createElement('div');
        body.className = 'msg-body';
        body.innerHTML = renderBlocks(t.content);
        wrap.appendChild(body);
        els.threadInner.insertBefore(wrap, stream);
        hydrateImageCards(body);
      } else {
        appendTurnDom(t);
      }
    }
    // 0.4.127 — after new bubbles are added, if the chat has an existing
    // memory card, migrate it into the strip of the last asst bubble so
    // it never sits above trailing prose (screenshot 46).
    // 0.4.188 — disabled: v0.4.184 already dedupes memcards per-bubble via
    // `onMemoryObservation`, so each asst turn owns its own card. Running
    // this migration whenever a new asst bubble appears was YANKING turn
    // N's card down into turn N+1's strip → turn N left cardless while
    // turn N+1 rendered the OLD summary (screenshots 41/42). The original
    // "sits above trailing prose" case (screenshot 46) is stale — cards
    // are now inserted into the strip on creation, so misplacement can't
    // recur.
    // migrateMemoryCardToLastAsst();
    pruneFalseEmptyHints();
    groupAdjacentToolOnlyBubbles();
    scrollThreadToEnd();
  }

  /** 0.4.203 — visually merge N consecutive assistant bubbles that
   *  contain ONLY tool_use/tool_result blocks (no text, no thinking)
   *  into one on-screen card. Each iter of the model's tool loop creates
   *  its own bubble in the DOM, so a 4-step bash run reads as 4 stacked
   *  cards. This post-render pass wraps a run of ≥2 tool-only bubbles
   *  in a single <div class="tool-run-group"> so CSS can draw one
   *  cohesive card around them. Idempotent — re-runs after every
   *  render/stream update. */
  function groupAdjacentToolOnlyBubbles() {
    if (!els.threadInner) return;
    // 0.4.205 — group at BLOCK level (inside each asst body), not at
    // bubble level. A run of ≥1 consecutive tool blocks between any
    // non-tool block (text, thinking, memcard) opens/closes a card.
    const bodies = els.threadInner.querySelectorAll('.msg-assistant .msg-body');
    bodies.forEach(body => {
      // Unwrap any prior groups (idempotent).
      body.querySelectorAll(':scope > .tool-run-group').forEach(g => {
        const parent = g.parentNode;
        while (g.firstChild) parent.insertBefore(g.firstChild, g);
        parent.removeChild(g);
      });
      const isTool = (el) => !!(el && el.matches && el.matches('.tool-card, .blk-tool-use'));
      const nodes = Array.from(body.children);
      let i = 0;
      while (i < nodes.length) {
        if (!isTool(nodes[i])) { i++; continue; }
        let j = i;
        while (j < nodes.length && isTool(nodes[j])) j++;
        if (j - i >= 1) {
          const grp = document.createElement('div');
          grp.className = 'tool-run-group';
          nodes[i].parentNode.insertBefore(grp, nodes[i]);
          for (let k = i; k < j; k++) grp.appendChild(nodes[k]);
        }
        i = j;
      }
    });
  }

  /** Per-turn memory cards must stay anchored to their originating
   *  assistant bubble. Kept as a no-op for older call sites that still invoke
   *  the former tail-migration helper. */
  function migrateMemoryCardToLastAsst() {
    return;
  }

  function appendBlocksTo(bodyEl, blocks) {
    if (!bodyEl) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderBlocks(blocks);
    // v0.4.19 — dedup globally across the chat (see absorbToolResultIntoLast).
    const existingPaths    = new Set(
      [...els.threadInner.querySelectorAll('.blk-file-card[data-file-path]')].map(el => el.dataset.filePath),
    );
    const existingImgPaths = new Set(
      [...els.threadInner.querySelectorAll('.blk-image-card[data-img-path]')].map(el => el.dataset.imgPath),
    );
    // 0.4.131 — append inline; artifact strip no longer used for file/image
    // cards (see absorbToolResultIntoLast).
    Array.from(tmp.children).forEach((child) => {
      const fp = child.dataset && child.dataset.filePath;
      const ip = child.dataset && child.dataset.imgPath;
      if (fp && existingPaths.has(fp))    return;
      if (ip && existingImgPaths.has(ip)) return;
      bodyEl.appendChild(child);
    });
    hydrateImageCards(bodyEl);
  }


  /* ── settings: system prompt editor (P5.6) ──────────────────────── */

  let spTier = 'global';   // 'global' | 'project' | 'chat'

  async function spLoad() {
    const ctrls = $('#spControls');
    const editor = $('#spEditor');
    const defBadge = document.getElementById('spDefaultBadge');
    const ovrBadge = document.getElementById('spOverrideBadge');
    let value = '';
    let isDefault = false;

    if (spTier === 'global') {
      ctrls.innerHTML = `<span class="muted small">Sent on every turn — covers tone, output-medium guidance, tool discipline, and how the extension's tool loop works. Editing here saves a custom override; "Reset to default" wipes the override and the built-in text comes back.</span>`;
      const r = await rpc('systemPrompt.get', { tier: 'global' });
      value = promptDisplayText(r);
      isDefault = !!r?.isDefault;
    } else if (spTier === 'chat') {
      ctrls.innerHTML = `<span class="muted small">Per-chat prompts apply ONLY to the current chat — appended after global + project. Empty = no per-chat tier.</span>`;
      const r = await rpc('systemPrompt.get', { tier: 'chat', chatId: state.activeChatId });
      value = promptDisplayText(r);
      isDefault = !!r?.isDefault;
    } else {
      const opts = state.projects.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      ctrls.innerHTML = `<select id="spProjSel">${opts}</select> <span class="muted small">Per-project prompts apply to every chat under the selected project.</span>`;
      const sel = $('#spProjSel');
      sel.value = state.activeProjectId;
      sel.onchange = spLoad;
      const r = await rpc('systemPrompt.get', { tier: 'project', projectId: sel.value });
      value = promptDisplayText(r);
      isDefault = !!r?.isDefault;
    }
    editor.value = value || '';
    if (defBadge) defBadge.hidden = !isDefault;
    if (ovrBadge) ovrBadge.hidden =  isDefault;
  }

  async function spSave() {
    const value = $('#spEditor').value;
    const payload = { tier: spTier, value };
    if (spTier === 'project') payload.projectId = $('#spProjSel').value;
    if (spTier === 'chat')    payload.chatId    = state.activeChatId;
    await rpc('systemPrompt.set', payload);
  }

  function bindSystemPromptUi() {
    document.querySelectorAll('.sp-tab').forEach(t => {
      t.onclick = () => {
        document.querySelectorAll('.sp-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        spTier = t.dataset.tier;
        spLoad();
      };
    });
    $('#spSave').onclick = spSave;
    $('#spReset').onclick = async () => {
      const payload = { tier: spTier, value: '' };
      if (spTier === 'project') payload.projectId = $('#spProjSel').value;
      if (spTier === 'chat')    payload.chatId    = state.activeChatId;
      await rpc('systemPrompt.set', payload);
      await spLoad();
    };
  }

  /* ── settings: pricing editor (P5.6) ─────────────────────────────── */

  async function pricingLoad() {
    const { defaults, overrides } = await rpc('pricing.get');
    const tbody = $('#pricingBody');
    const rows = Object.keys(defaults).map(model => {
      const def = defaults[model];
      const ovr = overrides[model] || {};
      const cur = { ...def, ...ovr };
      const isOverridden = Object.keys(ovr).length > 0;
      return `<tr data-model="${model}">
        <td><b>${model}</b></td>
        <td><input type="number" step="0.01" min="0" data-field="in"          value="${cur.in}"          ${isOverridden && ovr.in          !== undefined ? 'class="dirty"' : ''}/></td>
        <td><input type="number" step="0.01" min="0" data-field="out"         value="${cur.out}"         ${isOverridden && ovr.out         !== undefined ? 'class="dirty"' : ''}/></td>
        <td><input type="number" step="0.01" min="0" data-field="cacheRead"   value="${cur.cacheRead  ?? ''}" placeholder="—" /></td>
        <td><input type="number" step="0.01" min="0" data-field="cacheWrite"  value="${cur.cacheWrite ?? ''}" placeholder="—" /></td>
        <td><button class="row-reset" data-act="resetPrice" ${isOverridden ? '' : 'disabled'}>↺</button></td>
      </tr>`;
    }).join('');
    tbody.innerHTML = rows;

    tbody.oninput = async (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const inputs = tr.querySelectorAll('input[type=number]');
      const price = {};
      inputs.forEach(i => {
        const v = i.value.trim();
        if (v !== '') price[i.dataset.field] = parseFloat(v);
      });
      await rpc('pricing.set', { model: tr.dataset.model, price });
      tr.querySelector('button.row-reset').disabled = false;
    };
    tbody.onclick = async (e) => {
      const btn = e.target.closest('button[data-act="resetPrice"]');
      if (!btn) return;
      const tr = btn.closest('tr');
      await rpc('pricing.set', { model: tr.dataset.model, price: null });
      pricingLoad();
    };
  }

  /* ── settings: host controls (0.4.419) ────────────────────────────
   * Mirror the VS Code sidebar (proxy / sandbox / sandbox-dev lifecycle,
   * excalidraw, credentials, preset) inside the Settings panel so the whole
   * extension is configurable from the chat UI. Destructive + native ops are
   * hidden in the browser; the backend also refuses them for that origin. */
  const HOST_SVCS = ['proxy', 'sandbox', 'sandbox-dev'];
  const HOST_SVC_LABELS = { 'proxy': 'Proxy', 'sandbox': 'Sandbox', 'sandbox-dev': 'Sandbox (Developer)' };
  let hostCanControl = !IS_BROWSER;
  let hostInited = false;

  function hostSvcRowHtml(svc, s) {
    s = s || {};
    const dot  = s.ready ? 'on' : (s.hasImage ? 'warn' : 'off');
    const stat = !s.available ? 'not configured'
               : s.ready      ? `running · :${s.port}`
               : s.hasImage   ? 'stopped'
               :                 'no image';
    const adopted = s.adopted ? ' <span class="host-tag">adopted</span>' : '';
    const meta    = s.imageTag ? ` · <code>${escapeHtml(s.imageTag)}</code>` : '';
    const canAct  = hostCanControl && s.available;
    const acts = canAct ? `
      <button class="ghost-btn" data-host-op="build"   data-svc="${svc}">Build</button>
      <button class="ghost-btn" data-host-op="install" data-svc="${svc}">Install</button>
      <button class="ghost-btn" data-host-op="stop"    data-svc="${svc}">Stop</button>
      <button class="ghost-btn danger" data-host-op="remove"      data-svc="${svc}">Remove</button>
      <button class="ghost-btn danger" data-host-op="removeImage" data-svc="${svc}">Rm image</button>
      <button class="ghost-btn danger" data-host-op="purge"       data-svc="${svc}">Purge</button>`
      : '<span class="muted">view only</span>';
    return `<div class="host-svc${s.available ? '' : ' host-svc-off'}">
      <div class="host-svc-head">
        <span class="host-status"><span class="host-dot ${dot}"></span> ${HOST_SVC_LABELS[svc] || svc}</span>
        <span class="host-svc-meta">${stat}${adopted}${meta}</span>
      </div>
      <div class="host-actions">${acts}</div>
    </div>`;
  }

  function hostRender(st) {
    if (!st) return;
    if (typeof st.canControl === 'boolean') hostCanControl = st.canControl && !IS_BROWSER;
    const cont = $('#hostContainers');
    if (cont) cont.innerHTML = HOST_SVCS.map(svc => hostSvcRowHtml(svc, st[svc])).join('');
    const connectWrap = $('#hostConnectWrap');
    if (connectWrap) connectWrap.hidden = !hostCanControl;

    const el = $('#hostEnvLabel');
    if (el) el.textContent = (st.creds && st.creds.path)
      ? `Env file: ${st.creds.path} (${st.creds.loaded}/${st.creds.total} keys)`
      : 'Env file: none';
    const pl = $('#hostPresetLabel'); if (pl) pl.textContent = `preset: ${st.presetName || 'linux'}`;
  }

  async function hostLoad() {
    try { hostRender(await rpc('host.state')); }
    catch (e) { console.warn('[studio] hostLoad:', e); }
  }

  /** Run a host RPC, surface {error} + exceptions as a toast, refresh cards. */
  async function hostRpc(type, payload, okMsg) {
    try {
      const res = await rpc(type, payload);
      if (res && res.error) { showToast(res.error, 'error', 5000); return null; }
      if (okMsg && !(res && res.cancelled)) showToast(okMsg);
      if (res && res.state) hostRender(res.state); else hostLoad();
      return res;
    } catch (e) {
      showToast(`${type} failed: ${(e && e.message) || e}`, 'error', 5000);
      return null;
    }
  }

  function hostInit() {
    if (hostInited) return;
    hostInited = true;

    // Browser client: hide every VS-Code-only surface (backend refuses them
    // anyway).
    if (IS_BROWSER) {
      ['hostExcalidrawCard', 'hostPresetCard'].forEach(id => { const n = document.getElementById(id); if (n) n.hidden = true; });
      const pick = $('#hostEnvPickBtn');   if (pick) pick.hidden = true;
    }

    // Container build/install/stop/remove/removeImage/purge — event-delegated
    // because rows are re-rendered on every state change.
    const cont = $('#hostContainers');
    if (cont) cont.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-host-op]');
      if (!btn) return;
      const svc = btn.dataset.svc, op = btn.dataset.hostOp;
      const label = HOST_SVC_LABELS[svc] || svc;
      if (op === 'remove' || op === 'removeImage' || op === 'purge') {
        const what = op === 'purge'       ? `purge ${label} (container + image)`
                   : op === 'removeImage' ? `remove the ${label} image`
                   :                         `remove the ${label} container`;
        const ok = await showConfirmModal('Confirm', `This will ${what}. Continue?`, { okText: op === 'purge' ? 'Purge' : 'Remove', danger: true });
        if (!ok) return;
      }
      await hostRpc('host.action', { svc, op }, `${label}: ${op} done`);
    });

    // Connect existing proxy
    const connectToggle = $('#hostConnectToggle');
    if (connectToggle) connectToggle.addEventListener('click', async () => {
      const picker = $('#hostProxyPicker');
      if (!picker) return;
      if (!picker.hidden) { picker.hidden = true; return; }
      picker.hidden = false;
      picker.innerHTML = '<span class="muted">scanning…</span>';
      try {
        const { containers } = await rpc('host.listProxies');
        if (!containers || !containers.length) { picker.innerHTML = '<span class="muted">No running proxy containers found.</span>'; return; }
        picker.innerHTML = containers.map(c =>
          `<button class="ghost-btn" data-connect-port="${c.port}">${escapeHtml(c.name)} · :${c.port}${c.owned ? '' : ' (external)'}</button>`
        ).join('');
      } catch (e) { picker.innerHTML = `<span class="muted">scan failed: ${escapeHtml((e && e.message) || String(e))}</span>`; }
    });
    const picker = $('#hostProxyPicker');
    if (picker) picker.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-connect-port]');
      if (!b) return;
      picker.hidden = true;
      await hostRpc('host.connect', { port: Number(b.dataset.connectPort) }, 'Connected to proxy');
    });

    // Custom upstream provider — Format + URL (+ optional key) → proxy /admin/provider.
    const provConnect = $('#hostProviderConnect');
    if (provConnect) provConnect.addEventListener('click', async () => {
      const mode = $('#hostProviderFormat')?.value || 'openai';
      const url  = ($('#hostProviderUrl')?.value || '').trim();
      const key  = $('#hostProviderKey')?.value || '';
      if (!url) { showToast('Enter the provider URL (include /v1)', 'error'); return; }
      const res = await hostRpc('host.setProvider', { mode, url, key }, null);
      if (res && res.ok) {
        applyProviderState(res);
        const n = (res.models || []).length;
        if (n) showToast(`Upstream: ${mode} @ ${res.api_root || url} · ${n} models`);
        else showToast(`Connected to ${res.api_root || url} but it returned 0 models — check the URL / that it exposes /v1/models`, 'error');
      } else {
        showToast((res && res.error) || 'Failed to switch provider', 'error');
      }
    });
    const provReset = $('#hostProviderReset');
    if (provReset) provReset.addEventListener('click', async () => {
      const res = await hostRpc('host.setProvider', { mode: 'default' }, null);
      if (res && res.ok) { applyProviderState(res); refreshModelPicker(); showToast('Upstream reset — not connected'); }
    });
    // Reflect the proxy's current upstream when the panel opens.
    rpc('host.getProvider').then(p => { if (p && !p.error) applyProviderState(p); }).catch(() => {});

    // MinerU server URL — same fetch-on-load + Save pattern as the provider block above.
    const mineruSave = $('#mineruUrlSave');
    if (mineruSave) mineruSave.addEventListener('click', async () => {
      const url = ($('#mineruUrlInput')?.value || '').trim();
      await hostRpc('host.setMineruUrl', { url }, 'MinerU URL saved');
    });
    rpc('host.getMineruUrl').then(r => { if (r && !r.error) { const inp = $('#mineruUrlInput'); if (inp) inp.value = r.url || ''; } }).catch(() => {});

    // Excalidraw
    const exc = $('#hostExcalidrawCard');
    if (exc) exc.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-excalidraw]');
      if (!b) return;
      const act = b.dataset.excalidraw;
      const map = { start: 'host.excalidrawStart', stop: 'host.excalidrawStop', open: 'host.excalidrawOpen' };
      await hostRpc(map[act], {}, act === 'open' ? null : `Excalidraw ${act}`);
    });

    // Credentials — env file, preset
    const envPick  = $('#hostEnvPickBtn');   if (envPick)  envPick.addEventListener('click',  () => hostRpc('host.pickEnvFile',  {}, 'Env file loaded'));
    const envClear = $('#hostEnvClearBtn');  if (envClear) envClear.addEventListener('click', () => hostRpc('host.clearEnvFile', {}, 'Env file cleared'));
    const presetEdit  = $('#hostPresetEditBtn');  if (presetEdit)  presetEdit.addEventListener('click',  () => hostRpc('host.presetEdit',  {}, null));
    const presetReset = $('#hostPresetResetBtn'); if (presetReset) presetReset.addEventListener('click', () => hostRpc('host.presetReset', {}, 'Preset reset'));
  }

  /* on settings open: load editors */
  function settingsLoadAll() { spLoad(); pricingLoad(); hostInit(); hostLoad(); }
  els.settingsBtn.addEventListener('click', settingsLoadAll);
  els.topGearBtn.addEventListener('click', settingsLoadAll);
  bindSystemPromptUi();


  /* ── Developer Mode (v0.2.16) ──────────────────────────────────────
   *
   * The 🛡️ button next to the attach button. While ON, the next chat.send
   * payload carries developerMode=true so the host:
   *   • drops sandboxLevel to 'off' (no bwrap, no venv jail for bash)
   *   • opens network for sandboxed processes
   *   • runs tools in the active VS Code workspace folder
   *
   * State is in-memory only — closing the WebView (window reload) wipes it
   * to zero. We do not persist developerMode anywhere; the user opts in
   * fresh every session, mirroring how cursor-pretty IDEs handle "danger"
   * toggles.
   *
   * The banner is purely informational; the model still sees the same
   * bash/python tools — only their runtime context changes.
   */
  state.developerMode = false;

  function bindDeveloperMode() {
    const btn = $('#devModeBtn');
    const banner = $('#devModeBanner');
    if (!btn) return;
    const apply = () => {
      btn.classList.toggle('on', state.developerMode);
      btn.setAttribute('aria-pressed', state.developerMode ? 'true' : 'false');
      btn.title = state.developerMode
        ? 'Developer Mode is ON — click to disable. The sandbox-dev container has /data and $HOME mounted rw.'
        : 'Developer Mode — route tool calls to the sandbox-dev container with workspace rw mounts. Requires Sandbox-Dev to be installed first (sidebar → Sandbox-Dev).';
      if (banner) banner.hidden = !state.developerMode;
    };
    btn.onclick = async () => {
      // Turning OFF is always safe — no precondition.
      if (state.developerMode) {
        state.developerMode = false;
        apply();
        return;
      }
      // Turning ON: confirm the sandbox-dev container exists, otherwise
      // warn the user (with an Install affordance) instead of silently
      // letting the next send fail later. 0.4.8.
      try {
        const r = await rpc('sandboxDev.status');
        if (!r?.installed) {
          showDevSandboxMissingToast();
          return;   // leave developerMode OFF
        }
      } catch (e) {
        console.warn('[studio] sandboxDev.status probe failed:', e);
        // If we can't even probe, fall through to the toast — better to
        // ask the user to install than to risk a confusing later failure.
        showDevSandboxMissingToast();
        return;
      }
      state.developerMode = true;
      apply();
    };
    apply();
  }

  /** Warning toast when the user toggles Developer Mode without the
   *  Sandbox-Dev container installed. By design we do NOT auto-install —
   *  the user wants explicit control over Docker containers. They have
   *  to go to the AURA sidebar's Sandbox-Dev card and click Install. */
  function showDevSandboxMissingToast() {
    const msg = 'Developer Mode requires the Sandbox-Dev container. Open the Aether sidebar → Sandbox-Dev → Build image, then Install container.';
    if (typeof showToast === 'function') {
      showToast(msg, 'warn', 9000);
    } else {
      console.warn('[studio]', msg);
      alert(msg);
    }
  }

  /* ── attachments (P5.7) ─────────────────────────────────────────── */

  /** 0.4.189 — ensure there's an activeChatId before firing an attach RPC.
   *  The backend needs it to route the parsed .md into the per-chat folder;
   *  without it the file gets a random hash but no cascade delete target.
   *  Creates an Orphan chat on the fly if the user hasn't started one. */
  async function ensureChatIdForAttach() {
    if (state.activeChatId) return state.activeChatId;
    try {
      const c = await rpc('chats.create', {
        projectId:   '',
        model:       els.modelPicker.value,
        temperature: readActiveTemperature(),
      });
      state.activeChatId = c.id;
      state.chats.unshift(c);
      refreshProjectLabel();
      applyTemperatureForChat(c.id);
      return c.id;
    } catch (e) {
      console.warn('[studio] ensureChatIdForAttach failed:', e);
      return '';
    }
  }

  function bindAttachments() {
    const attachBtn  = $('#attachBtn');
    const attachInp  = $('#attachInput');
    const dropOver   = $('#dropOverlay');
    const composer   = $('#composer');

    // 0.4.179 — swapped defaults. Under remote-SSH (the primary use case),
    // the file the user wants to parse lives on the Linux host where the
    // sandbox/proxy run, not on the Windows/Mac client. Click now opens
    // the Linux picker by default; shift-click / right-click fall back to
    // the client-side VS Code file input for when the user actually does
    // hold the bytes locally (e.g. a screenshot on the laptop).
    attachBtn.onclick = async (ev) => {
      if (ev.shiftKey) {
        attachInp.click();
        return;
      }
      // 0.4.182 — pickFromHost is a two-stage RPC: (1) VS Code showOpenDialog
      // returns the chosen path, (2) backend runs AttachmentParser (MinerU
      // for docs = seconds-to-minutes). Prior versions awaited both stages
      // then appended the chip, so the user saw no feedback between "picked
      // in dialog" and "chip appears in strip". Mirror ingestFile's
      // optimistic-chip pattern: after the dialog closes we don't know the
      // filename yet (backend does the picking), so we defer chip creation
      // to inside a nested await — but keep the parsing chip visible for
      // the whole parse duration. To do that we split the RPC into two:
      // attach.pickFromHostPath (just the dialog) then attach.addByPath.
      let picked;
      try { picked = await rpc('attach.pickFromHostPath'); }
      catch (e) { console.warn('[studio] host pick error:', e); return; }
      if (!picked || picked.cancelled) return;
      if (picked.error) { console.warn('[studio] host pick error:', picked.error); return; }
      const abs = String(picked.path || '');
      if (!abs) return;
      const tmpId = 'tmp-' + Math.random().toString(36).slice(2, 8);
      const filename = abs.split(/[\\/]/).pop() || 'file';
      const chip = makeChip({ id: tmpId, filename, parsing: true });
      $('#attachStrip').appendChild(chip);
      const chatIdForAttach = await ensureChatIdForAttach();
      let r;
      try { r = await rpc('attach.addByPath', { path: abs, chatId: chatIdForAttach }); }
      catch (e) {
        chip.classList.add('error');
        chip.querySelector('.label').textContent = `${filename} — ${e.message}`;
        return;
      }
      if (r && r.error) {
        chip.classList.add('error');
        chip.querySelector('.label').textContent = `${filename} — ${r.error}`;
        return;
      }
      const finalChip = makeChip({ ...r, id: r.hash });
      chip.replaceWith(finalChip);
      state.pendingAttachments.push(r);
    };
    attachBtn.oncontextmenu = (ev) => {
      ev.preventDefault();
      attachInp.click();
    };
    attachInp.onchange = async () => {
      for (const f of attachInp.files) await ingestFile(f);
      attachInp.value = '';
    };

    let dragDepth = 0;
    composer.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (++dragDepth === 1) dropOver.hidden = false;
    });
    composer.addEventListener('dragleave', () => {
      if (--dragDepth <= 0) { dragDepth = 0; dropOver.hidden = true; }
    });
    composer.addEventListener('dragover',  (e) => { e.preventDefault(); });
    composer.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropOver.hidden = true;
      // 1) OS file drop (file picker / desktop).
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        for (const f of e.dataTransfer.files) await ingestFile(f);
        return;
      }
      // 2) VS Code editor / explorer drag → comes as text/uri-list (or the
      //    VS Code-private mime). The host can read these absolute paths
      //    directly without us having to re-upload bytes.
      const types = e.dataTransfer.types || [];
      const uriListMime = ['application/vnd.code.uri-list','text/uri-list']
        .find(t => Array.from(types).includes(t));
      if (uriListMime) {
        const raw = e.dataTransfer.getData(uriListMime);
        const uris = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
        for (const u of uris) {
          await ingestVsCodeUri(u);
        }
        return;
      }
      // 3) Plain text (e.g. selection drag) → drop into composer as quote.
      const txt = e.dataTransfer.getData('text/plain');
      if (txt) {
        els.composerInput.value = (els.composerInput.value
          ? els.composerInput.value + '\n\n' : '') + txt;
        autoGrow();
      }
    });
  }

  /** Resolve a file:// or untitled: URI dropped from VS Code's editor or
   *  Explorer. The host reads bytes off disk, parses with the same
   *  AttachmentParser we use for native files, and returns the same chip
   *  payload. Untitled URIs (unsaved) cannot be read — show inline error. */
  async function ingestVsCodeUri(rawUri) {
    let abs = '';
    try {
      const u = new URL(rawUri);
      if (u.protocol === 'file:') abs = decodeURIComponent(u.pathname);
      else if (u.protocol === 'untitled:') {
        // Show a soft warning chip — we can't read unsaved buffers.
        const c = makeChip({ id: 'untitled', filename: rawUri.replace('untitled:', ''), parsing: false, notes: 'unsaved — save in VS Code first' });
        c.classList.add('error');
        $('#attachStrip').appendChild(c);
        return;
      }
    } catch {
      // Plain path (rare). Treat as absolute if it starts with / or X:\
      if (/^([a-zA-Z]:[\\/]|\/)/.test(rawUri)) abs = rawUri;
    }
    if (!abs) return;
    const tmpId = 'tmp-' + Math.random().toString(36).slice(2, 8);
    const filename = abs.split(/[\\/]/).pop() || 'file';
    const chip = makeChip({ id: tmpId, filename, parsing: true });
    $('#attachStrip').appendChild(chip);
    const chatIdForAttach = await ensureChatIdForAttach();
    try {
      const result = await rpc('attach.addByPath', { path: abs, chatId: chatIdForAttach });
      if (result?.error) {
        chip.classList.add('error');
        chip.querySelector('.label').textContent = `${filename} — ${result.error}`;
        return;
      }
      const finalChip = makeChip({ ...result, id: result.hash });
      chip.replaceWith(finalChip);
      state.pendingAttachments.push(result);
    } catch (e) {
      chip.classList.add('error');
      chip.querySelector('.label').textContent = `${filename} — ${e.message}`;
    }
  }

  /** Mime types that need MinerU to be useful. Falls back to "filename only"
   *  if the user declines installation. */
  const MINERU_NEEDED_EXTS = ['.pdf', '.docx', '.pptx', '.xlsx', '.epub'];
  /** Tracks whether we've already asked the user about MinerU this session. */
  let _minerBannerShown = false;
  let _minerBannerSession = { declined: false };

  async function ingestFile(file) {
    // If this is a MinerU-needed file and it's not installed, ask once.
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    if (MINERU_NEEDED_EXTS.includes(ext) && !_minerBannerSession.declined) {
      try {
        const status = await rpc('mcp.minerStatus');
        if (!status?.installed && !_minerBannerShown) {
          _minerBannerShown = true;
          const choice = await showMinerUBanner(file.name);
          if (choice === 'install') {
            // Block on install — Studio shows VS Code's progress notification.
            try {
              await rpc('mcp.installMineru');
            } catch (e) {
              console.warn('[studio] MinerU install failed:', e);
            }
          } else if (choice === 'never') {
            _minerBannerSession.declined = true;
          }
          // If choice === 'simple' just continue with the simple parser.
        }
      } catch (e) { console.warn('[studio] minerStatus probe failed:', e); }
    }

    // Optimistic chip
    const tmpId = 'tmp-' + Math.random().toString(36).slice(2, 8);
    const chip = makeChip({ id: tmpId, filename: file.name, sizeBytes: file.size, parsing: true });
    $('#attachStrip').appendChild(chip);

    const buf = await file.arrayBuffer();
    const b64 = arrayBufferToBase64(buf);
    const chatIdForAttach = await ensureChatIdForAttach();
    let result;
    try {
      result = await rpc('attach.add', { name: file.name, dataBase64: b64, chatId: chatIdForAttach });
    } catch (e) {
      chip.classList.add('error');
      chip.querySelector('.label').textContent = `${file.name} — ${e.message}`;
      return;
    }
    if (result && result.error) {
      chip.classList.add('error');
      chip.querySelector('.label').textContent = `${file.name} — ${result.error}`;
      return;
    }

    // Replace chip with finalized version
    const finalChip = makeChip({ ...result, id: result.hash });
    chip.replaceWith(finalChip);
    state.pendingAttachments.push(result);
  }

  /**
   * Modal banner offering 3 choices: Install MinerU now / Use simple parser /
   * Don't ask again. Returns 'install' | 'simple' | 'never'.
   */
  function showMinerUBanner(filename) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.innerHTML = `
        <div class="modal-card mineru-banner">
          <div class="modal-title">📕 Parsing ${escapeHtml(filename)}</div>
          <p class="muted small" style="line-height:1.55;margin:8px 0 12px;">
            <b>MinerU</b> extracts text + tables + figures from PDF/DOCX/PPTX/XLSX into clean Markdown.
            It runs <b>locally</b> — no API key needed — but the install is heavy:
            <b>~3 GB of wheels</b> + <b>~6 GB of models</b> on first run.
            <br><br>
            Without it, the model only sees the filename. Install once and every chat (plus Claude Code, Cursor, etc) can use it.
          </p>
          <div class="modal-actions" style="flex-wrap:wrap;gap:8px;">
            <button class="primary-btn" data-act="install">Install MinerU (~3 GB)</button>
            <button class="ghost-btn"  data-act="simple">Use simple parser</button>
            <button class="ghost-btn"  data-act="never">Don't ask again</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        ov.remove();
        resolve(act);
      });
    });
  }

  function makeChip({ id, filename, hash, sizeBytes, notes, parsing, parsedMd, mimeType, inlineHint, path: p }) {
    const div = document.createElement('div');
    div.className = 'attach-chip' + (parsing ? ' parsing' : '');
    div.dataset.hash = hash || id;
    const sz = formatSize(sizeBytes);
    const tip = notes ? ` — ${notes}` : '';

    // Image attachments — render a real thumbnail instead of the 📎 icon.
    // Webviews can't read absolute host paths directly, so we round-trip
    // through file.readAsDataUri (the host already supports this RPC for
    // the preview pane).  The chip stays usable during the fetch — we
    // start with the icon, swap to the <img> when bytes arrive.
    const isImage = mimeType && mimeType.startsWith('image/');
    div.innerHTML = `
      <span class="ico">${isImage ? '🖼️' : '📎'}</span>
      <span class="label" title="${escapeHtml((notes || ''))}">${escapeHtml(filename || 'file')} <span class="muted small">${sz}${tip ? ' · ' + escapeHtml(tip.slice(3)) : ''}</span></span>
      <button class="x" title="Remove">✕</button>
    `;
    if (isImage && p) {
      rpc('file.readAsDataUri', { path: p }).then(r => {
        if (!r || r.error || !r.dataUri) return;
        const ico = div.querySelector('.ico');
        if (!ico) return;
        const img = document.createElement('img');
        img.src = r.dataUri;
        img.className = 'attach-thumb';
        img.alt = filename || 'image';
        ico.replaceWith(img);
      }).catch(() => { /* keep emoji fallback */ });
    }

    if (!isImage && (parsedMd || p)) {
      div.classList.add('previewable');
      div.title = 'Open parsed attachment preview';
      div.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        const artId = addArtifact({
          kind: parsedMd ? 'md' : 'text',
          title: filename || 'attachment',
          source: parsedMd || '',
          path: p || '',
          text: parsedMd || inlineHint || '',
          filename,
        });
        selectArtifact(artId);
        openArtifactPanel();
      });
    }

    div.querySelector('.x').onclick = () => {
      div.remove();
      const key = hash || id;
      state.pendingAttachments = state.pendingAttachments.filter(a => (a.hash || a.id) !== key);
      // 0.4.202 — tell backend to drop the RAM-cached markdown so it
      // doesn't hang around wasting memory (and would never be flushed
      // since the chip is gone).
      if (hash) rpc('attach.discard', { hash }).catch(() => { /* best-effort */ });
    };
    return div;
  }

  function formatSize(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function arrayBufferToBase64(buf) {
    let bin = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  bindAttachments();
  bindDeveloperMode();
  bindArtifactPanel();
  bindMineruPanel();

  function onMineruPickBackend(p) {
    const reqId = p?.reqId;
    const filename = p?.filename || 'document';

    // Create inline picker overlay on the composer
    const overlay = document.createElement('div');
    overlay.className = 'mineru-pick-overlay';
    overlay.innerHTML = `
      <div class="mineru-pick-box">
        <div class="mineru-pick-title">Parse <b>${filename}</b> with MinerU</div>
        <button class="mineru-pick-btn mineru-pick-pipeline" data-val="pipeline">
          ⚡ <b>Pipeline</b> <span>fast · ~1–3 min · text-heavy docs</span>
        </button>
        <button class="mineru-pick-btn mineru-pick-hybrid" data-val="hybrid-engine">
          ⚙ <b>Hybrid engine</b> <span>slow · 10–30 min · complex diagrams &amp; formulas</span>
        </button>
        <button class="mineru-pick-cancel">Cancel</button>
      </div>
    `;

    function pick(val) {
      overlay.remove();
      vscode.postMessage({ type: 'mineru.backendPicked', reqId, backend: val });
    }

    overlay.querySelector('.mineru-pick-pipeline').onclick = () => pick('pipeline');
    overlay.querySelector('.mineru-pick-hybrid').onclick   = () => pick('hybrid-engine');
    overlay.querySelector('.mineru-pick-cancel').onclick   = () => pick('cancel');

    document.body.appendChild(overlay);
    overlay.querySelector('.mineru-pick-pipeline').focus();
  }

  function bindMineruPanel() {
    const dot      = document.getElementById('mineruBarDot');
    const stateEl  = document.getElementById('mineruBarState');
    if (!dot || !stateEl) return;

    function setDot(color) { dot.className = 'mineru-bar-dot ' + color; }

    function setState(text, color, detail) {
      const boardOpen = document.body.classList.contains('mineru-board-open');
      stateEl.textContent = boardOpen ? text : '';
      stateEl.parentElement.title = detail || text;
      setDot(color);
    }

    window.__AURA_MINERU_MONITOR__ = async () => {
      const data = await rpc('mineru.monitor');
      if (data && data.ok === false) throw new Error(data.error || 'monitor unavailable');
      return data;
    };
    window.__AURA_MINERU_CONTROL__ = async (action) => {
      const data = await rpc('mineru.control', { action });
      if (data && data.ok === false) throw new Error(data.error || 'control unavailable');
      return data;
    };

    function formatUptime(sec) {
      const n = Number(sec);
      if (!Number.isFinite(n) || n <= 0) return '';
      const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = Math.floor(n % 60);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }

    function mineruDetail(data) {
      const parts = [];
      const srv = data.server || {};
      if (data.version) parts.push(`version: ${data.version}`);
      if (srv.host) parts.push(`server: ${srv.host}`);
      if (srv.pid) parts.push(`pid: ${srv.pid}`);
      if (srv.uptime_secs || srv.uptime) parts.push(`uptime: ${formatUptime(srv.uptime_secs || srv.uptime) || srv.uptime}`);
      if (srv.cpu_pct != null || srv.cpuPct != null) parts.push(`cpu: ${srv.cpu_pct ?? srv.cpuPct}%`);
      if (srv.ram_mb != null || srv.ramMb != null) parts.push(`ram: ${srv.ram_mb ?? srv.ramMb}MB`);
      const t = data.tasks || {};
      parts.push(`tasks: queued=${t.queued ?? 0} parsing=${t.processing ?? 0} completed=${t.completed ?? 0} failed=${t.failed ?? 0}`);
      if (t.currentId) parts.push(`current: ${t.currentId}`);
      if (t.currentFile) parts.push(`file: ${t.currentFile}`);
      if (Array.isArray(data.gpu) && data.gpu.length) {
        parts.push(...data.gpu.map((g, i) => `gpu${g.id ?? i}: ${g.name || ''} ${g.vramUsedMb ?? '?'} / ${g.vramTotalMb ?? '?'} MB (${g.vramPct ?? '?'}%) util=${g.utilPct ?? '?'}% temp=${g.tempC ?? '?'}C power=${g.powerW ?? '?'}W${g.modelLoaded ? ' · model loaded' : ''}`));
      }
      if (Array.isArray(data.kit) && data.kit.length) parts.push(`kit: ${data.kit.join(', ')}`);
      if (Array.isArray(data.vlm) && data.vlm.length) parts.push(`vlm: ${data.vlm.join(', ')}`);
      return parts.join('\n');
    }

    async function loadMineruDashboardHtml(data) {
      try {
        if (!state._mineruDashboardHtml) {
          const dash = await rpc('mineru.dashboard');
          if (!dash || dash.ok === false || !dash.html) throw new Error(dash?.error || 'dashboard unavailable');
          state._mineruDashboardHtml = dash.html;
        }
        return state._mineruDashboardHtml;
      } catch (e) {
        if (!data || !data.running) throw e;
        const srv = data.server || {}, t = data.tasks || {};
        const gpus = Array.isArray(data.gpu) ? data.gpu : [];
        const uptime = formatUptime(srv.uptime_secs || srv.uptime);
        const gpuHtml = gpus.map((g, i) => `
          <span class="mineru-gpu-name">GPU${g.id ?? i} ${escapeHtml(g.name || '')}</span>
          <span>VRAM ${g.vramUsedMb ?? '?'} / ${g.vramTotalMb ?? '?'} MB (${g.vramPct ?? '?'}%)</span>
          <span>Temp ${g.tempC ?? '?'}°C</span>
          <span>Util ${g.utilPct ?? '?'}%</span>
          <span>Power ${g.powerW ?? '?'}W</span>`).join('');
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:16px;background:#11151d;color:#e5e7eb;font:13px system-ui,-apple-system,sans-serif}
          .mineru-runtime-line{display:flex;gap:10px;flex-wrap:wrap;padding:9px 11px;margin:0 0 8px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.04)}
          .mineru-runtime-grid{display:grid;grid-template-columns:auto repeat(5,minmax(0,1fr));gap:8px;padding:9px 11px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:rgba(255,255,255,.04)}
          .ok-dot{color:#58c878}.current-task{color:#f0c36a}.mineru-gpu-name{color:#93c5fd}
        </style></head><body>
          <div class="mineru-runtime-line"><b>Status</b><span class="ok-dot">●</span><span>${escapeHtml(data.state || 'idle')}</span><span>pid=${escapeHtml(String(srv.pid || ''))}</span><span>uptime=${escapeHtml(uptime || String(srv.uptime || ''))}</span><span>cpu=${escapeHtml(String(srv.cpu_pct ?? srv.cpuPct ?? '?'))}%</span><span>ram=${escapeHtml(String(srv.ram_mb ?? srv.ramMb ?? '?'))}MB</span></div>
          <div class="mineru-runtime-line"><b>Tasks</b><span>queued=${t.queued ?? 0}</span><span>parsing=${t.processing ?? 0}</span><span>done=${t.completed ?? 0}</span><span>failed=${t.failed ?? 0}</span>${t.currentId ? `<span class="current-task">${escapeHtml(String(t.currentId))}</span>` : ''}</div>
          ${data.kit?.length ? `<div class="mineru-runtime-line"><b>Kit</b><span>${escapeHtml(data.kit.join('  '))}</span></div>` : ''}
          ${data.vlm?.length ? `<div class="mineru-runtime-line"><b>VLM</b><span>${escapeHtml(data.vlm.join('  '))}</span></div>` : `<div class="mineru-runtime-line"><b>VLM</b><span>none</span></div>`}
          ${gpuHtml ? `<div class="mineru-runtime-grid"><b>GPU</b>${gpuHtml}</div>` : ''}
        </body></html>`;
      }
    }

    async function openMineruControlPanel(data) {
      let statusData = data;
      if (!statusData) {
        try { statusData = await rpc('mineru.status'); } catch {}
      }
      const html = await loadMineruDashboardHtml(statusData);
      closeArtifactGallery();
      _activeArtifactId = null;
      renderArtifactTabs();
      if (els.artifactTabs) els.artifactTabs.innerHTML = '<span class="artifact-control-title">⛏️ MinerU Control</span>';
      openArtifactPanel();
      els.artifactPanel?.classList.add('mineru-control-open');
      const body = els.artifactBody;
      if (!body) return;
      body.innerHTML = '';
      const viewport = document.createElement('div');
      viewport.className = 'artifact-zoom-viewport mineru-control-frame';
      viewport.style.height = 'calc(100vh - 112px)';
      const frame = document.createElement('iframe');
      frame.className = 'artifact-frame';
      frame.sandbox = 'allow-scripts allow-forms allow-same-origin';
      frame.srcdoc = html || '';
      viewport.appendChild(frame);
      body.appendChild(viewport);
      installArtifactZoom(body, frame, { zoomState: { scale: 1 } });
    }
    window.__AURA_OPEN_MINERU_CONTROL__ = openMineruControlPanel;

    async function renderMineruRuntime(data, forceOpen = false) {
      const el = document.getElementById('mineruRuntime');
      if (!el) return;
      el.hidden = true;
      document.body.classList.remove('mineru-board-open');
      const toggle = document.getElementById('mineruBoardToggle');
      toggle?.setAttribute('aria-expanded', 'false');
      if (forceOpen) {
        try { await openMineruControlPanel(data); }
        catch (e) {
          const msg = `MinerU dashboard unavailable\n${String(e?.message || e || 'unknown error')}`;
          const artId = addArtifact({ kind: 'text', title: 'MinerU Control', source: msg });
          selectArtifact(artId);
          openArtifactPanel();
        }
      }
    }

    async function refresh() {
      try {
        const data = await rpc('mineru.status');
        if (!data || data.error) { await renderMineruRuntime(null); setState(data?.label || data?.error || 'unreachable', 'red'); return; }
        if (!data.running) { await renderMineruRuntime(null); setState(data.label || 'offline', 'red'); return; }
        const state = data.state || 'idle';
        const color = state === 'processing' || state === 'queued' ? 'yellow' : state === 'failed' || state === 'offline' ? 'red' : 'green';
        await renderMineruRuntime(data);
        setState(data.label || state, color, mineruDetail(data));
      } catch (e) { await renderMineruRuntime(null); setState('unreachable', 'red'); }
    }

    const toggle = document.getElementById('mineruBoardToggle');
    if (toggle) {
      toggle.onclick = async () => {
        toggle.setAttribute('aria-expanded', 'true');
        await renderMineruRuntime(null, true);
      };
    }

    refresh();
    setInterval(refresh, 2000);
  }


  function bindArtifactPanel() {
    if (!els.artifactClose) return;
    els.artifactClose.onclick = () => closeArtifactPanel();
    els.artifactGalleryBtn?.addEventListener('click', () => state.artifactGalleryOpen ? closeArtifactGallery() : openArtifactGallery());
    els.mineruPanelBtn?.addEventListener('click', async () => {
      try {
        closeArtifactGallery();
        const openMineru = window.__AURA_OPEN_MINERU_CONTROL__;
        if (typeof openMineru !== 'function') throw new Error('MinerU control panel is not ready');
        await openMineru(null);
      }
      catch (e) { showToast('MinerU panel failed: ' + (e && e.message || e), 'error', 5000); }
    });
    els.artifactGalleryClose?.addEventListener('click', closeArtifactGallery);
    els.artifactGallerySort?.addEventListener('change', () => {
      state.artifactGallerySort = els.artifactGallerySort.value || 'newest';
      localStorage.setItem('auraStudio.artifactGallerySort', state.artifactGallerySort);
      renderArtifactGallery();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('has-artifact')) {
        // Don't steal Esc if a modal is open — modal handlers run first.
        if ($('#modalOverlay').hidden && (els.settings?.hidden ?? true)) {
          closeArtifactPanel();
        }
      }
    });
    // Splitter for artifact panel — same drag mechanic as main rail.
    // Use Pointer Events + setPointerCapture so the splitter keeps receiving
    // pointermove/up even when the cursor hovers over the artifact iframe
    // (which would otherwise swallow events and "stick" the divider to the
    // pointer until the user clicks again — issue #3a in 0.4.1).
    if (els.artifactSplitter) {
      let pid = null;
      const overlay = (() => {
        const o = document.createElement('div');
        o.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;display:none';
        document.body.appendChild(o);
        return o;
      })();
      let lastX = 0;
      let lastW = 480;
      let raf = 0;
      const applyDrag = () => {
        raf = 0;
        if (pid === null) return;
        // 0.4.140 — allow artifact panel up to viewport-width - 360px so
        // the user can drag the splitter far to the left (leaving room
        // for the rail + minimum chat area). Previously capped at 900px
        // which felt narrow on wide monitors.
        const maxW = Math.max(600, window.innerWidth - 360);
        lastW = Math.max(280, Math.min(maxW, window.innerWidth - lastX));
        document.documentElement.style.setProperty('--artifact-w', `${lastW}px`);
      };
      els.artifactSplitter.addEventListener('pointerdown', (e) => {
        pid = e.pointerId;
        lastX = e.clientX;
        els.artifactSplitter.setPointerCapture(pid);
        document.body.style.userSelect = 'none';
        overlay.style.display = 'block';
        e.preventDefault();
      });
      els.artifactSplitter.addEventListener('pointermove', (e) => {
        if (pid === null) return;
        lastX = e.clientX;
        if (!raf) raf = requestAnimationFrame(applyDrag);
      });
      const release = (e) => {
        if (pid === null) return;
        try { els.artifactSplitter.releasePointerCapture(pid); } catch {}
        pid = null;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        document.body.style.userSelect = '';
        overlay.style.display = 'none';
        localStorage.setItem('auraStudio.artifactW', String(lastW));
      };
      els.artifactSplitter.addEventListener('pointerup',     release);
      els.artifactSplitter.addEventListener('pointercancel', release);
      window.addEventListener('blur',                        release);
      const saved = parseInt(localStorage.getItem('auraStudio.artifactW') || '480', 10);
      if (!Number.isNaN(saved)) document.documentElement.style.setProperty('--artifact-w', `${saved}px`);
    }
  }

  const _artifacts = new Map();
  let _artifactIdSeq = 0;
  let _activeArtifactId = null;

  function updateArtifactStatusPill() {
    const pill = els.artifactStatusPill || document.getElementById('artifactStatusPill');
    if (!pill) return;
    const a = _activeArtifactId ? _artifacts.get(_activeArtifactId) : null;
    if (!a) { pill.hidden = true; pill.textContent = ''; return; }
    pill.hidden = false;
    pill.textContent = `Preview: ${a.title || a.filename || a.kind || 'artifact'}`;
    pill.title = document.body.classList.contains('has-artifact') ? 'Preview is open' : 'Open current preview';
    pill.onclick = () => {
      if (!_activeArtifactId) return;
      openArtifactPanel();
      selectArtifact(_activeArtifactId);
    };
  }

  function openArtifactPanel() {
    document.body.classList.add('has-artifact');
    els.artifactPanel.hidden = false;
    els.artifactSplitter.hidden = false;
    updateArtifactStatusPill();
  }
  function closeArtifactPanel() {
    document.body.classList.remove('has-artifact');
    els.artifactPanel?.classList.remove('mineru-control-open');
    els.artifactPanel.hidden = true;
    els.artifactSplitter.hidden = true;
    updateArtifactStatusPill();
  }

  /** Add an artifact (HTML / SVG / Mermaid / Pyodide / Text / docx-html / PDF).
   *  Returns the assigned id (used by tab selection). The optional `path` is
   *  saved so the artifact panel can show a Download link for file-derived
   *  artifacts. */
  function addArtifact({ kind, title, source, path, data, text, lang, delimiter, filename, artifactId, chatId, mediaType, live, version, updatedAt }) {
    // 0.4.133 — carry `data`/`text`/`lang`/`delimiter`/`filename` for
    // library-rendered kinds (docx-raw/xlsx-raw/pptx-raw/pdf-raw/epub-raw/
    // csv-raw/json-raw/code-highlighted/md).
    // Dedup by (kind, path or data-length-hash) — re-rendering during
    // stream/tool-loop would otherwise create a fresh tab every flush.
    const contentKey = path || hashString(String(source || data || text || ''));
    const key = kind + '\x00' + contentKey;
    for (const [existingId, a] of _artifacts.entries()) {
      const existingKey = a.kind + '\x00' + (a.path || hashString(String(a.source || a.data || a.text || '')));
      if (existingKey === key) {
        Object.assign(a, { kind, title, source, path, data, text, lang, delimiter, filename, artifactId, chatId, mediaType, live, version, updatedAt });
        renderArtifactTabs();
        return existingId;
      }
    }
    const id = 'art-' + (++_artifactIdSeq);
    _artifacts.set(id, { kind, title, source, path, data, text, lang, delimiter, filename, artifactId, chatId, mediaType, live, version, updatedAt });
    renderArtifactTabs();
    return id;
  }
  function hashString(s) {
    // FNV-1a 32-bit. Cheap, deterministic, no crypto API needed.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }
  /** Preview a sandbox-served file URL (http://127.0.0.1:<port>/artifacts/...)
   *  in the artifact panel. Adds a tab whose iframe simply points at the URL
   *  — works directly for PDF, images, text, HTML; office files become
   *  Download-only since browsers can't render them. The artifact panel
   *  already has its own Download chip too. (#8 in 0.2.18) */
  function previewSandboxFile(url, filename, mediaType) {
    const id = 'art-' + (++_artifactIdSeq);
    // Reuse the existing kind dispatch where it makes sense; otherwise use
    // a new 'iframe-url' kind that selectArtifact() handles below.
    _artifacts.set(id, { kind: 'iframe-url', title: filename, source: url, path: null, mediaType });
    renderArtifactTabs();
    selectArtifact(id);
    openArtifactPanel();
    return id;
  }
  function renderArtifactTabs() {
    if (!els.artifactTabs) return;
    // Each tab gets a small × so the user can drop ONE preview without
    // closing the whole panel (issue: only the panel-level × existed before;
    // when 2 files were open, you couldn't dismiss just one).
    els.artifactTabs.innerHTML = [..._artifacts.entries()].map(([id, a]) =>
      `<span class="artifact-tab-wrap${id === _activeArtifactId ? ' active' : ''}">
        <button class="artifact-tab" data-id="${id}" title="${escapeAttr(a.title)}">
          ${kindIcon(a.kind)} ${escapeHtml(a.title)}
        </button>
        <button class="artifact-tab-close" data-close-id="${id}" title="Close this tab" aria-label="Close tab">×</button>
      </span>`
    ).join('');
    els.artifactTabs.onclick = (e) => {
      const closeBtn = e.target.closest('button[data-close-id]');
      if (closeBtn) {
        e.stopPropagation();
        removeArtifact(closeBtn.dataset.closeId);
        return;
      }
      const tab = e.target.closest('button[data-id]');
      if (tab) selectArtifact(tab.dataset.id);
    };
  }
  /** Close a single artifact tab. If it was active and others remain, switch
   *  to the next one; if it was the last tab, hide the whole panel. */
  function removeArtifact(id) {
    if (!_artifacts.has(id)) return;
    const wasActive = id === _activeArtifactId;
    _artifacts.delete(id);
    if (wasActive) _activeArtifactId = null;
    if (_artifacts.size === 0) {
      closeArtifactPanel();
      els.artifactBody.innerHTML = '';
      renderArtifactTabs();
      updateArtifactStatusPill();
      return;
    }
    if (wasActive) {
      const nextId = [..._artifacts.keys()][0];
      selectArtifact(nextId);
    } else {
      renderArtifactTabs();
    }
  }
  function kindIcon(k) {
    if (k === 'html')      return '🌐';
    if (k === 'mineru-dashboard') return '⛏️';
    if (k === 'svg')       return '✏️';
    if (k === 'mermaid')   return '🧭';
    if (k === 'pyodide')   return '🐍';
    if (k === 'docx-html' || k === 'docx-raw') return '📝';
    if (k === 'xlsx-html' || k === 'xlsx-raw') return '📊';
    if (k === 'pptx-html' || k === 'pptx-raw') return '📙';
    if (k === 'pdf' || k === 'pdf-raw') return '📕';
    if (k === 'epub-raw')  return '📚';
    if (k === 'csv-raw')   return '📈';
    if (k === 'json-raw')  return '🧾';
    if (k === 'md')        return '📝';
    if (k === 'code-highlighted') return '📄';
    if (k === 'text')      return '📄';
    return '📄';
  }

  // 0.4.133 — lazy-load a vendored library script into the parent
  // (webview top-level) context. Returns a Promise that resolves once the
  // script has executed. Cached so repeat calls are no-ops.
  const _vendorLoaded = new Map();
  // 0.4.136 — defensive base builder with multi-source fallback. The primary
  // source is window.__AURA_VENDOR_BASE__ set from index.html via the backend
  // template substitution. If that global is empty/missing (e.g. a restored
  // webview panel from a pre-0.4.133 install where the placeholder never got
  // substituted), we scrape the actual vendor URI from the DOMPurify script
  // tag that was loaded eagerly by index.html — that URL was substituted at
  // extension load time and is guaranteed to include the webview origin +
  // vendor/ path. Last resort: derive from app.js own script src.
  let _vendorBaseCached = '';
  function _vendorBase() {
    if (_vendorBaseCached) return _vendorBaseCached;
    let b = window.__AURA_VENDOR_BASE__ || '';
    if (b && !b.endsWith('/')) b += '/';
    if (b && !b.includes('{{')) { _vendorBaseCached = b; return b; }
    // Fallback A: scrape DOMPurify script tag (index.html line 16).
    try {
      const nodes = document.querySelectorAll('script[src]');
      for (const s of nodes) {
        const src = s.src || '';
        const idx = src.lastIndexOf('/vendor/');
        if (idx !== -1) { _vendorBaseCached = src.slice(0, idx + '/vendor/'.length); return _vendorBaseCached; }
      }
    } catch {}
    // Fallback B: derive from any script tag by stripping the filename and
    // appending vendor/. Assumes app.js lives one level up from vendor/.
    try {
      const scripts = document.querySelectorAll('script[src]');
      if (scripts.length) {
        const src = scripts[scripts.length - 1].src || '';
        const slash = src.lastIndexOf('/');
        if (slash !== -1) { _vendorBaseCached = src.slice(0, slash + 1) + 'vendor/'; return _vendorBaseCached; }
      }
    } catch {}
    return b;
  }
  function loadVendorScript(relPath) {
    if (_vendorLoaded.has(relPath)) return _vendorLoaded.get(relPath);
    const base = _vendorBase();
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + relPath;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + relPath + ' (src=' + s.src + ')'));
      document.head.appendChild(s);
    });
    _vendorLoaded.set(relPath, p);
    return p;
  }
  function base64ToUint8(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function artifactZoomState(a) {
    if (!a) return { scale: 1 };
    if (!a.zoomState) a.zoomState = { scale: 1 };
    return a.zoomState;
  }

  function installArtifactZoom(body, content, a) {
    const z = artifactZoomState(a);
    const controls = document.createElement('div');
    controls.className = 'artifact-zoom-controls';
    const pct = document.createElement('span');
    pct.className = 'artifact-zoom-pct';
    const apply = () => {
      z.scale = Math.max(0.25, Math.min(3, Number(z.scale) || 1));
      pct.textContent = `${Math.round(z.scale * 100)}%`;
      content.style.transform = `scale(${z.scale})`;
      content.style.transformOrigin = 'top left';
      // Do not shrink the layout box as zoom increases. HTML/SVG artifacts
      // reflow when width is divided by scale, so diagrams appeared smaller
      // at 300%. Keep the natural size and let the panel scroll the scaled
      // content, like a browser page zoom.
      content.style.width = '100%';
      content.style.height = '100%';
    };
    body.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      z.scale += e.deltaY < 0 ? 0.1 : -0.1;
      apply();
    }, { passive: false });
    const mk = (label, title, fn, act) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'artifact-zoom-btn'; b.textContent = label; b.title = title;
      if (act) b.dataset.zoomAct = act;
      b.addEventListener('click', fn);
      return b;
    };
    controls.appendChild(mk('−', 'Zoom out', () => { z.scale -= 0.1; apply(); }, 'out'));
    controls.appendChild(pct);
    controls.appendChild(mk('+', 'Zoom in', () => { z.scale += 0.1; apply(); }, 'in'));
    controls.appendChild(mk('100%', 'Reset zoom', () => { z.scale = 1; apply(); }));
    body.appendChild(controls);
    apply();
  }

  function selectArtifact(id) {
    const a = _artifacts.get(id);
    if (!a) return;
    _activeArtifactId = id;
    renderArtifactTabs();
    const body = els.artifactBody;
    body.innerHTML = '';
    const pinTopUntil = Date.now() + 3000;
    body.dataset.pinTopUntil = String(pinTopUntil);
    body.scrollTop = 0;
    body.scrollLeft = 0;
    const keepTop = () => {
      if (Number(body.dataset.pinTopUntil || 0) < Date.now()) return;
      body.scrollTop = 0;
      body.scrollLeft = 0;
      requestAnimationFrame(keepTop);
    };
    requestAnimationFrame(keepTop);

    // For file-derived artifacts (text/docx-html/pdf) we render a small toolbar
    // with a Download link above the iframe. Pure-codeblock artifacts skip this.
    updateArtifactStatusPill();

    if (a.path) {
      const bar = document.createElement('div');
      bar.className = 'artifact-toolbar';
      bar.innerHTML = `<span class="muted small artifact-path">${escapeHtml(a.path)}</span>
        <button class="img-dl" data-act="downloadFile" data-file-path="${escapeAttr(a.path)}">⬇ Download</button>`;
      bar.querySelector('button').onclick = () => saveAsDownload({ path: a.path });
      body.appendChild(bar);
    }

    // 0.4.133 — new "raw" kinds render into a live DOM container in the
    // parent webview context (so vendored libs can attach into it). Older
    // artifact kinds still use the iframe path below.
    const RAW_KINDS = new Set(['docx-raw','xlsx-raw','pptx-raw','pdf-raw','epub-raw','csv-raw','json-raw','code-highlighted','md']);
    if (RAW_KINDS.has(a.kind)) {
      const viewport = document.createElement('div');
      viewport.className = 'artifact-zoom-viewport';
      viewport.style.height = a.path ? 'calc(100vh - 192px)' : 'calc(100vh - 152px)';
      const host = document.createElement('div');
      host.className = 'artifact-native';
      viewport.appendChild(host);
      body.appendChild(viewport);
      installArtifactZoom(body, host, a);
      renderRawArtifact(a, host).catch(err => {
        host.innerHTML = `<div class="artifact-error">Preview failed: ${escapeHtml(String(err && err.message || err))}</div>`;
      });
      return;
    }

    const viewport = document.createElement('div');
    viewport.className = 'artifact-zoom-viewport';
    viewport.style.height = a.path ? 'calc(100vh - 192px)' : 'calc(100vh - 152px)';
    const frame = document.createElement('iframe');
    frame.className = 'artifact-frame';
    frame.dataset.artifactFrame = '1';
    frame.dataset.keepTopUntil = String(Date.now() + 3000);
    frame.name = 'af-' + String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    frame.sandbox = a.kind === 'mineru-dashboard' ? 'allow-scripts allow-forms allow-same-origin' : 'allow-scripts';
    viewport.appendChild(frame);
    body.appendChild(viewport);
    installArtifactZoom(body, frame, a);

    if (a.kind === 'html') {
      // 0.4.133 — sanitize model-authored HTML with DOMPurify before rendering.
      const clean = (window.DOMPurify && DOMPurify.sanitize(a.source, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true, svg: true } })) || a.source;
      frame.dataset.noAutoResize = '1';
      frame.style.height = '100%';
      frame.srcdoc = artifactHtmlSrcdoc(clean, frame.name);
    } else if (a.kind === 'mineru-dashboard') {
      frame.srcdoc = a.source || '';
    } else if (a.kind === 'svg') {
      const cleanSvg = (window.DOMPurify && DOMPurify.sanitize(a.source || a.text || '', { USE_PROFILES: { svg: true, svgFilters: true } })) || (a.source || a.text || '');
      frame.srcdoc = `<!DOCTYPE html><html><head><style>body{margin:0;display:flex;align-items:center;justify-content:center;background:#fff;height:100vh}svg{max-width:100%;max-height:100%}</style></head><body>${cleanSvg}</body></html>`;
    } else if (a.kind === 'mermaid') {
      // Inline mermaid.js (UMD) loaded from data URL — keeps WebView CSP happy.
      // Falls back to plain text if mermaid bundle isn't available.
      frame.srcdoc = mermaidSrcdoc(a.source);
    } else if (a.kind === 'pyodide') {
      frame.srcdoc = pyodideSrcdoc(a.source);
    } else if (a.kind === 'text') {
      // Plain text/code preview — escaped, monospace, scrollable.
      frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{margin:0;padding:14px 18px;font-family:ui-monospace,'JetBrains Mono',monospace;font-size:13px;line-height:1.55;background:#fff;color:#222;white-space:pre-wrap;word-break:break-word}
        </style></head><body>${escapeHtml(a.source)}</body></html>`;
    } else if (a.kind === 'docx-html' || a.kind === 'xlsx-html' || a.kind === 'pptx-html') {
      // Host already converted Office → HTML. Wrap in basic chrome.
      frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{margin:0;padding:24px;font-family:'Source Serif 4',Georgia,serif;font-size:14px;line-height:1.6;background:#fff;color:#222;max-width:900px}
        h1,h2,h3,h4{font-family:Inter,system-ui,sans-serif}
        table{border-collapse:collapse;width:100%;margin:8px 0}
        th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}
        thead{background:#f3f3f3}
        .pptx-slide{border:1px solid #ddd;border-radius:12px;padding:18px 22px;margin:0 0 18px;background:#fafafa;box-shadow:0 1px 4px rgba(0,0,0,.05)}
        .pptx-slide h2{margin-top:0;color:#222}
        </style></head><body>${a.source}</body></html>`;
    } else if (a.kind === 'pdf') {
      // Host returned a data URL. Browsers render PDF inline via <embed>.
      frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body{margin:0;padding:0;background:#222;height:100vh}
        embed{width:100%;height:100%}
        </style></head><body><embed src="${escapeAttr(a.source)}" type="application/pdf"></body></html>`;
    } else if (a.kind === 'iframe-url') {
      // Sandbox-served URL preview (#8 in 0.2.18). Image / PDF / text / html
      // render natively in the iframe; office types show "browser can't
      // preview this — use Download" so the user is never blocked.
      const mt = a.mediaType || '';
      if (mt.startsWith('image/')) {
        frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{margin:0;display:flex;align-items:center;justify-content:center;background:#222;height:100vh}
          img{max-width:100%;max-height:100%;object-fit:contain;background:#fff}
          </style></head><body><img src="${escapeAttr(a.source)}" alt=""></body></html>`;
      } else if (mt === 'application/pdf') {
        frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:0;background:#222;height:100vh}
          embed{width:100%;height:100%}
          </style></head><body><embed src="${escapeAttr(a.source)}" type="application/pdf"></body></html>`;
      } else if (mt.startsWith('text/') || mt === 'application/json') {
        frame.src = a.source;
      } else if (mt === 'text/html') {
        frame.src = a.source;
      } else {
        // Office / archive / unknown — let the browser try, but warn.
        frame.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:32px;font-family:system-ui,-apple-system,sans-serif;color:#444;background:#fafafa}
          a{color:#0366d6}
          </style></head><body>
          <h2>Preview not supported</h2>
          <p>The browser can't preview <code>${escapeHtml(mt || 'this file type')}</code> inline. Use the <strong>Download</strong> button beside the file card to save it locally and open with a native app.</p>
          <p><a href="${escapeAttr(a.source)}" target="_blank" rel="noopener">Try opening directly →</a></p>
          </body></html>`;
      }
    }
  }

  function artifactHtmlSrcdoc(html, frameName) {
    const safeName = String(frameName || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;min-height:100%;overflow:visible}
    </style></head><body>${html}<script>
      (() => {
        const postSize = () => parent.postMessage({type:'aura.artifact.resize',name:${JSON.stringify(safeName)},h:Math.max(document.documentElement.scrollHeight,document.body&&document.body.scrollHeight||0)}, '*');
        addEventListener('load', postSize);
        try { new ResizeObserver(postSize).observe(document.documentElement); } catch {}
        addEventListener('wheel', e => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          parent.postMessage({type:'aura.artifact.zoom',name:${JSON.stringify(safeName)},deltaY:e.deltaY}, '*');
        }, {passive:false});
        setTimeout(postSize, 50); setTimeout(postSize, 500);
      })();
    <\/script></body></html>`;
  }

  /** 0.4.133 — render a "raw" artifact (docx-raw / xlsx-raw / pptx-raw /
   *  pdf-raw / epub-raw / csv-raw / json-raw / code-highlighted / md) into
   *  a live DOM host. Each branch lazy-loads its vendored library and
   *  hands off rendering. Errors bubble up to selectArtifact's catch. */
  async function renderRawArtifact(a, host) {
    if (a.kind === 'docx-raw') {
      await loadVendorScript('jszip.min.js');
      await loadVendorScript('docx-preview.min.js');
      const u8 = base64ToUint8(a.data);
      host.innerHTML = '<div class="docx-body"></div>';
      const target = host.querySelector('.docx-body');
      await window.docx.renderAsync(u8, target, null, {
        inWrapper: false,
        ignoreWidth: false,
        ignoreHeight: false,
        ignoreFonts: false,
      });
      return;
    }

    if (a.kind === 'xlsx-raw') {
      await loadVendorScript('xlsx.mini.min.js');
      const u8 = base64ToUint8(a.data);
      const wb = window.XLSX.read(u8, { type: 'array', cellStyles: true });
      const names = wb.SheetNames || [];
      host.innerHTML = `<div class="xlsx-tabs"></div><div class="xlsx-body"></div>`;
      const tabs = host.querySelector('.xlsx-tabs');
      const bodyEl = host.querySelector('.xlsx-body');
      const showSheet = (name) => {
        [...tabs.children].forEach(b => b.classList.toggle('active', b.textContent === name));
        const html = window.XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false });
        bodyEl.innerHTML = html;
      };
      names.forEach(n => {
        const b = document.createElement('button');
        b.className = 'xlsx-tab';
        b.textContent = n;
        b.onclick = () => showSheet(n);
        tabs.appendChild(b);
      });
      if (names.length) showSheet(names[0]);
      return;
    }

    if (a.kind === 'pptx-raw') {
      await loadVendorScript('jszip.min.js');
      if (!window.JSZip && window.jszip) window.JSZip = window.jszip;
      // 0.4.138 — pptxviewjs UMD factory reads t.Chart at call time. If
      // Chart is undefined the factory may throw internally and never
      // reach the export assignments. Provide a stub so factory completes.
      if (!window.Chart) {
        window.Chart = function ChartStub(){ return { destroy(){}, update(){}, resize(){} }; };
        window.Chart.register = function(){};
        window.Chart.defaults = { plugins: {}, scales: {} };
      }
      await loadVendorScript('pptxviewjs.min.js');
      const u8 = base64ToUint8(a.data);
      // 0.4.139 — PPTXViewer expects {canvas: <canvasElement>}, not a
      // container div. Wire up canvas + minimal slide nav so multi-slide
      // decks are viewable.
      host.innerHTML = '<div class="pptx-nav" style="display:flex;gap:8px;align-items:center;padding:6px 8px;font-size:12px;"><button class="pptx-prev">‹</button><span class="pptx-label">Slide —</span><button class="pptx-next">›</button></div><div class="pptx-body" style="display:flex;justify-content:center;padding:0;"><canvas class="pptx-canvas" style="background:#fff;display:block;"></canvas></div>';
      const canvas = host.querySelector('.pptx-canvas');
      const bodyDiv = host.querySelector('.pptx-body');
      const prevBtn = host.querySelector('.pptx-prev');
      const nextBtn = host.querySelector('.pptx-next');
      const label = host.querySelector('.pptx-label');
      const ns = window.PptxViewJS;
      const Ctor = (ns && (ns.PPTXViewer || (typeof ns === 'function' && ns))) || window.PPTXViewer;
      if (typeof Ctor !== 'function') {
        const keys = ns ? Object.keys(ns) : [];
        console.error('[pptx] ns=', ns, 'keys=', keys, 'window.PPTXViewer=', window.PPTXViewer);
        throw new Error('PptxViewJS constructor not found. ns keys=[' + keys.join(',') + '] typeof ns=' + typeof ns);
      }
      const viewer = new Ctor({ canvas, autoRenderFirstSlide: true, slideSizeMode: 'fit' });
      const file = new File([u8], a.filename || 'presentation.pptx', {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
      try {
        await viewer.loadFile(file);
      } catch (e) {
        console.error('[pptx] loadFile failed:', e);
        throw new Error('PptxViewJS loadFile failed: ' + (e && e.message ? e.message : String(e)));
      }
      let idx = 0;
      const total = typeof viewer.getSlideCount === 'function' ? viewer.getSlideCount() : 1;
      // 0.4.140 — resize canvas physical size to match panel width before
      // each render. Library uses canvas.width/height as internal render
      // resolution and auto-fits the slide (mode "fit") into it; without
      // this, the slide renders at default 960px into a much wider panel.
      const fitCanvasToPanel = () => {
        const w = Math.max(320, Math.floor(bodyDiv.clientWidth));
        const h = Math.floor(w * 9 / 16);
        // 0.4.142 — set BOTH physical size and CSS pixel size to the same
        // value. Library reads parseFloat(canvas.style.width) as its clip
        // rect width; if style.width is "100%" that parses to 100 (JS drops
        // the %) and clips the render to a 100px sliver → blank canvas.
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
      };
      const showSlide = async (i) => {
        idx = Math.max(0, Math.min(total - 1, i));
        fitCanvasToPanel();
        try { await viewer.render(canvas, { slideIndex: idx }); } catch (e) { console.error('[pptx] render slide', idx, 'failed:', e); }
        label.textContent = 'Slide ' + (idx + 1) + ' / ' + total;
        prevBtn.disabled = idx <= 0;
        nextBtn.disabled = idx >= total - 1;
      };
      prevBtn.addEventListener('click', () => showSlide(idx - 1));
      nextBtn.addEventListener('click', () => showSlide(idx + 1));
      // Re-render on window/panel resize (debounced) so slide fills the
      // new artifact panel width when user drags the splitter.
      let resizeTimer = null;
      const onResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => showSlide(idx), 120);
      };
      window.addEventListener('resize', onResize);
      showSlide(0);
      return;
    }

    if (a.kind === 'pdf-raw') {
      // pdf.js ships as ESM (.mjs). Use dynamic import instead of <script src>.
      // 0.4.355 — the import() and getDocument() can hang indefinitely without
      // ever throwing (e.g. CSP blocks the worker fetch). Race each against a
      // timer so a stall surfaces as a real error in the panel instead of an
      // eternal blank — mirrors the Pyodide guard below.
      const timeout = (ms, label) => new Promise((_, rej) => setTimeout(
        () => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms));
      const base = _vendorBase();
      if (!window.pdfjsLib) {
        const mod = await Promise.race([
          import(base + 'pdfjs/pdf.min.mjs'),
          timeout(20000, 'pdf.js module load'),
        ]);
        window.pdfjsLib = mod;
        mod.GlobalWorkerOptions.workerSrc = base + 'pdfjs/pdf.worker.min.mjs';
      }
      const pdfjs = window.pdfjsLib;
      const u8 = base64ToUint8(a.data);
      const pdf = await Promise.race([
        pdfjs.getDocument({ data: u8 }).promise,
        timeout(20000, 'PDF document load'),
      ]);
      host.innerHTML = '';
      const scroller = document.createElement('div');
      scroller.className = 'pdf-scroller';
      host.appendChild(scroller);
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        scroller.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      }
      return;
    }

    if (a.kind === 'epub-raw') {
      await loadVendorScript('jszip.min.js');
      await loadVendorScript('epub.min.js');
      const u8 = base64ToUint8(a.data);
      host.innerHTML = '<div class="epub-body"></div>';
      const target = host.querySelector('.epub-body');
      const book = window.ePub(u8.buffer);
      book.renderTo(target, { flow: 'scrolled-doc', width: '100%', height: '100%' });
      return;
    }

    if (a.kind === 'csv-raw') {
      await loadVendorScript('papaparse.min.js');
      const parsed = window.Papa.parse(a.text || '', {
        delimiter: a.delimiter || ',',
        skipEmptyLines: true,
      });
      const rows = parsed.data || [];
      const table = document.createElement('table');
      table.className = 'csv-table';
      if (rows.length) {
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        rows[0].forEach(c => {
          const th = document.createElement('th');
          th.textContent = c;
          trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        rows.slice(1).forEach(r => {
          const tr = document.createElement('tr');
          r.forEach(c => {
            const td = document.createElement('td');
            td.textContent = c;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
      }
      host.innerHTML = '';
      host.appendChild(table);
      return;
    }

    if (a.kind === 'json-raw') {
      await loadVendorScript('json-formatter.umd.js');
      let obj;
      try { obj = JSON.parse(a.text || ''); }
      catch (e) {
        host.innerHTML = `<pre class="json-fallback">${escapeHtml(a.text || '')}</pre>`;
        return;
      }
      const JF = window.JSONFormatter && (window.JSONFormatter.default || window.JSONFormatter);
      if (!JF) { host.innerHTML = `<pre>${escapeHtml(a.text || '')}</pre>`; return; }
      const formatter = new JF(obj, 2, { theme: '', open: 2 });
      host.innerHTML = '';
      host.appendChild(formatter.render());
      return;
    }

    if (a.kind === 'code-highlighted') {
      await loadVendorScript('highlight.min.js');
      const hl = window.hljs;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-' + (a.lang || 'plaintext');
      code.textContent = a.text || '';
      pre.appendChild(code);
      host.innerHTML = '';
      host.appendChild(pre);
      try { hl && hl.highlightElement(code); } catch {}
      return;
    }

    if (a.kind === 'md') {
      const canEdit = !!(a.artifactId && a.chatId && (a.mediaType === 'text/markdown' || /\.md$/i.test(a.filename || a.title || '')));
      const raw = String(a.text ?? a.source ?? '');
      const rawHtml = (typeof renderMarkdown === 'function') ? renderMarkdown(raw) : escapeHtml(raw);
      const clean = (window.DOMPurify && DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } })) || rawHtml;
      host.innerHTML = `${canEdit ? '<div class="artifact-md-toolbar"><button type="button" class="btn" data-md-act="edit">Edit</button><button type="button" class="btn" data-md-act="save" hidden>Save</button><button type="button" class="btn" data-md-act="cancel" hidden>Cancel</button></div>' : ''}<div class="md-body">${clean}</div>`;
      if (canEdit) {
        const toolbar = host.querySelector('.artifact-md-toolbar');
        const edit = toolbar.querySelector('[data-md-act="edit"]');
        const save = toolbar.querySelector('[data-md-act="save"]');
        const cancel = toolbar.querySelector('[data-md-act="cancel"]');
        const showPreview = () => { selectArtifact(_activeArtifactId); };
        edit.addEventListener('click', () => {
          const ta = document.createElement('textarea');
          ta.className = 'artifact-md-editor';
          ta.value = String(a.text ?? a.source ?? '');
          const body = host.querySelector('.md-body');
          body.replaceWith(ta);
          edit.hidden = true; save.hidden = false; cancel.hidden = false;
          ta.focus();
        });
        cancel.addEventListener('click', showPreview);
        save.addEventListener('click', async () => {
          const ta = host.querySelector('.artifact-md-editor');
          const content = ta ? ta.value : String(a.text ?? a.source ?? '');
          save.disabled = true;
          try {
            const r = await rpc('artifact.update', { chatId: a.chatId, id: a.artifactId, content });
            if (!r || r.error) throw new Error((r && r.error) || 'save failed');
            a.text = content; a.source = content; a.live = true; a.version = r.version; a.updatedAt = r.updatedAt;
            showToast('Markdown artifact saved', 'ok', 1800);
            showPreview();
          } catch (e) {
            showToast('Save failed: ' + (e && e.message || e), 'error', 5000);
          } finally {
            save.disabled = false;
          }
        });
      }
      return;
    }

    throw new Error('Unknown raw kind: ' + a.kind);
  }

  /** Scan an assistant message body for markdown code-fence artifacts and
   *  surface them as panel tabs. Only fires once per fence (idempotent via
   *  data-artifact-id attribute on the <pre>). */
  function harvestArtifactsFromBody(bodyEl) {
    if (!bodyEl) return;
    const cfg = window.__AURA_CFG__ || {};
    if (cfg.artifactPanel === 'off') return;
    const codeBlocks = bodyEl.querySelectorAll('pre.md-code:not([data-artifact-id])');
    codeBlocks.forEach(pre => {
      // 0.4.39 — never harvest a <pre> that already lives inside an
      // inline-rendered SVG/mermaid card. Otherwise the user sees BOTH
      // the live inline render AND a duplicate "SVG preview" pill that
      // routes to the panel (the bug reported in image copy 27/28).
      if (pre.closest('.blk-svg-card, .md-mermaid')) return;
      const lang = (pre.className.match(/lang-([\w-]+)/) || [, ''])[1].toLowerCase();
      const src = pre.querySelector('code')?.textContent || '';
      let kind = null, title = null;
      // SVG and mermaid are now rendered INLINE at markdown-render time.
      // Only html still routes through the panel (too heavy to inline).
      if (lang === 'html') { kind = 'html'; title = 'HTML preview'; }
      if (!kind) return;
      const id = addArtifact({ kind, title, source: src });
      pre.setAttribute('data-artifact-id', id);
      // 0.4.34 — when an artifact pill takes over, hide the wall of code
      // by default. Replace the <pre> with a <details> the user can
      // expand only if they want to read source. Mirrors Claude.ai's
      // "preview-first, source-on-demand" UX. The pill stays as the
      // primary entry point.
      const wrap = document.createElement('div');
      wrap.className = 'artifact-block';
      const pill = document.createElement('button');
      pill.className = 'artifact-open-pill';
      pill.textContent = `${kindIcon(kind)} ${title} →`;
      pill.onclick = () => { openArtifactPanel(); selectArtifact(id); };
      const details = document.createElement('details');
      details.className = 'artifact-source';
      details.innerHTML = `<summary class="artifact-source-summary">view source</summary>`;
      // Move the existing <pre> inside <details> instead of cloning, so
      // any later harvest run still finds it by data-artifact-id.
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pill);
      wrap.appendChild(details);
      details.appendChild(pre);
    });
  }

  function mermaidSrcdoc(src) {
    // Use jsdelivr ESM build; CSP allows https in img-src, but iframe sandbox
    // is its own origin so loading scripts here is fine.
    const safe = src.replace(/<\/script>/gi, '<\\/script>');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:16px;font-family:system-ui;background:#fff}
      .err{color:#b91c1c;font-family:monospace;white-space:pre-wrap}
      </style></head><body>
      <div class="mermaid">${escapeHtml(safe)}</div>
      <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
      try { mermaid.initialize({startOnLoad:true,theme:'default'}); }
      catch (e) { document.body.innerHTML = '<div class=err>'+e.message+'</div>'; }
      <\/script></body></html>`;
  }

  /** Run python code in the WebView via Pyodide WASM. Loads pyodide on
   *  first call (cached after that). The iframe shell prints stdout/stderr
   *  + any matplotlib figure produced by `plt.savefig(io)`. Cross-platform
   *  safe: WASM runs inside the Chromium sandbox, so even if the model
   *  writes random bytes nothing leaks to the host filesystem. */
  function pyodideSrcdoc(code) {
    const safe = JSON.stringify(code);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:14px;font-family:'JetBrains Mono',monospace;font-size:12.5px;background:#0d1117;color:#e6edf3}
      .out{white-space:pre-wrap;background:#161b22;border-radius:6px;padding:10px;margin:8px 0;color:#e6edf3}
      .err{white-space:pre-wrap;background:#3a1213;border:1px solid #5e1419;border-radius:6px;padding:10px;color:#ffa198}
      img{max-width:100%;background:white;border-radius:6px;display:block;margin:8px 0}
      .status{color:#8b949e;font-style:italic}
      </style></head><body>
      <div class="status" id="st">Loading Pyodide… (~10 MB, first time)</div>
      <pre class="out" id="out" hidden></pre>
      <pre class="err" id="err" hidden></pre>
      <div id="figs"></div>
      <script type="module">
      const code = ${safe};
      const out  = document.getElementById('out');
      const err  = document.getElementById('err');
      const st   = document.getElementById('st');
      const figs = document.getElementById('figs');
      function appendOut(s) { out.hidden = false; out.textContent += s; }
      function appendErr(s) { err.hidden = false; err.textContent += s; }
      // Timeout guard — Renesas Playground env blocks cdn.jsdelivr.net so
      // the import() can hang indefinitely without ever throwing. Race the
      // load against a 30s timer so the user sees a real error message.
      const timeout = (ms, label) => new Promise((_, rej) => setTimeout(
        () => rej(new Error(label + ' timed out after ' + ms + 'ms (CDN may be blocked)')), ms));
      try {
        const { loadPyodide } = await Promise.race([
          import('https://cdn.jsdelivr.net/pyodide/v0.26.0/full/pyodide.mjs'),
          timeout(30000, 'Pyodide module load'),
        ]);
        const pyo = await Promise.race([
          loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.0/full/' }),
          timeout(60000, 'Pyodide runtime init'),
        ]);
        st.textContent = 'Running…';
        pyo.setStdout({ batched: appendOut });
        pyo.setStderr({ batched: appendErr });
        try {
          // Auto-load packages from imports (numpy/pandas/matplotlib if used).
          await pyo.loadPackagesFromImports(code).catch(() => {});
          await pyo.runPythonAsync(code);
        } catch (e) {
          appendErr(String(e));
        }
        // Try to extract any matplotlib figures we drew.
        try {
          const has_mpl = pyo.runPython('"matplotlib" in __import__("sys").modules');
          if (has_mpl) {
            const png_b64 = pyo.runPython(\`
import io, base64
import matplotlib.pyplot as plt
buf=io.BytesIO()
for n in plt.get_fignums():
    plt.figure(n).savefig(buf, format='png', bbox_inches='tight')
    buf.write(b'~SEP~')
buf.getvalue()
\`);
            if (png_b64 && png_b64.length) {
              const parts = pyo.toPy ? pyo.toPy(png_b64) : png_b64;  // noop
              const buf  = png_b64;
              // png_b64 is a JS Uint8Array via emscripten
              const bytes = new Uint8Array(buf);
              // split on "~SEP~" tokens
              const SEP = new TextEncoder().encode('~SEP~');
              let start = 0;
              for (let i = 0; i + SEP.length <= bytes.length; ) {
                let match = true;
                for (let k = 0; k < SEP.length; k++) if (bytes[i+k] !== SEP[k]) { match = false; break; }
                if (match) {
                  const slice = bytes.slice(start, i);
                  if (slice.length) {
                    const img = document.createElement('img');
                    img.src = 'data:image/png;base64,'+btoa(String.fromCharCode(...slice));
                    figs.appendChild(img);
                  }
                  start = i + SEP.length; i = start;
                } else i++;
              }
            }
          }
        } catch (e) { /* mpl not used — fine */ }
        st.textContent = 'Done.';
      } catch (e) {
        st.textContent = 'Pyodide load failed';
        appendErr(String(e));
      }
      <\/script></body></html>`;
  }

})();
