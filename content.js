/**
 * Claude.ai RTL Fix — Content Script
 *
 * Strategy:
 *   1. Apply dir="auto" to the chat editor so direction shifts naturally as the
 *      user types Arabic/Hebrew vs. Latin characters.
 *   2. For each message paragraph AND list item, count the ratio of RTL code
 *      points to total letter code points. If >= RTL_THRESHOLD, set dir="rtl".
 *      Otherwise use dir="auto" and let the browser's UBA decide.
 *   3. A MutationObserver watches ONLY for new nodes (new messages), not for
 *      character data changes. Typing is handled exclusively by the input listener.
 *   4. All DOM writes are wrapped in withObserverPaused() to prevent our own
 *      setAttribute/style calls from re-triggering the observer (infinite loop).
 *   5. Mixed content (English words, numbers, math) inside RTL elements is
 *      handled automatically by the UBA — no extra logic required.
 *   6. Code blocks always stay LTR (enforced via styles.css).
 *
 * ── Bug history ─────────────────────────────────────────────────────────────
 *
 *  v1 BUG — Infinite observer loop (page freeze):
 *    Used `characterData: true` on document.body. Every keystroke fired the
 *    observer → stampBlock() called setAttribute → that DOM write fired the
 *    observer again → infinite loop.
 *    FIX: Removed characterData. Added withObserverPaused() around all writes.
 *
 *  v2 BUG 1 — List items not detected:
 *    SEL.blocks only contained `p` selectors. <li> elements in numbered/bulleted
 *    lists were never processed, so Arabic/Hebrew list items rendered LTR.
 *    FIX: Added `li` variants to SEL.blocks and to stampEditor's querySelectorAll.
 *
 *  v2 BUG 2 — Flickering during streaming:
 *    During streaming, Claude appends new nodes every ~100ms. Each batch fires
 *    the observer, which re-evaluates direction on partial text. The RTL ratio
 *    oscillates around the threshold as text accumulates, causing LTR<->RTL flips.
 *    FIX 1: Longer debounce (STREAMING_DEBOUNCE_MS) when streaming is active,
 *            so evaluation waits until a meaningful chunk has accumulated.
 *    FIX 2: RTL lock — once an element inside an active stream is stamped RTL,
 *            it stays RTL until streaming ends. Direction can only move LTR->RTL
 *            during a stream, never RTL->LTR.
 */

(function () {
  'use strict';

  // ─── Configuration ──────────────────────────────────────────────────────────

  const CONFIG = {
    // Fraction of letter characters that must be RTL to classify a block as RTL.
    rtlThreshold: 0.25,

    // Ignore elements with fewer than this many trimmed characters.
    minTextLength: 2,

    // Debounce for the input-event listener (typing direction updates).
    inputDebounceMs: 150,

    // Debounce for the observer when NO streaming is active (normal message arrival).
    observerDebounceMs: 250,

    // Longer debounce used while Claude is actively streaming a response.
    // Gives text time to accumulate before direction is evaluated, preventing
    // LTR<->RTL flickering on partial sentences.
    streamingDebounceMs: 600,

    // Debounce for SPA navigation re-scan.
    navDebounceMs: 600,

    storageKey: 'rtlfix_enabled',
  };

  // ─── RTL Unicode Ranges ─────────────────────────────────────────────────────
  //
  //  U+0590-U+05FF  Hebrew
  //  U+0600-U+06FF  Arabic
  //  U+0750-U+077F  Arabic Supplement
  //  U+08A0-U+08FF  Arabic Extended-A / Extended-B
  //  U+200F         RIGHT-TO-LEFT MARK
  //  U+202B         RIGHT-TO-LEFT EMBEDDING
  //  U+FB1D-U+FB4F  Hebrew Presentation Forms
  //  U+FB50-U+FDFF  Arabic Presentation Forms-A
  //  U+FE70-U+FEFF  Arabic Presentation Forms-B

  const RTL_RE    = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿ‏‫יִ-ﭏﭐ-﷿ﹰ-﻿]/g;
  const LETTER_RE = /\p{L}/gu;

  // ─── State ──────────────────────────────────────────────────────────────────

  let enabled     = true;
  let domObserver = null;

  // Cache: element -> last textContent string we processed.
  // Lets stampBlock skip the regex when text is unchanged AND dir is already set.
  // The el.hasAttribute('dir') guard in stampBlock ensures disable/re-enable works.
  const cache = new WeakMap();

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function rtlRatio(text) {
    const letters = text.match(LETTER_RE);
    if (!letters || letters.length < CONFIG.minTextLength) return 0;
    const rtl = text.match(RTL_RE);
    return (rtl ? rtl.length : 0) / letters.length;
  }

  // ─── Streaming detection ─────────────────────────────────────────────────────
  //
  // Claude.ai marks the element that is currently being streamed with
  // data-is-streaming. We use this to apply the RTL lock and longer debounce.

  function isStreamingActive() {
    return !!document.querySelector('[data-is-streaming]');
  }

  function isInsideStream(el) {
    return !!el.closest('[data-is-streaming]');
  }

  // ─── Observer pause / resume ─────────────────────────────────────────────────
  //
  // Every DOM write (setAttribute, style.setProperty) MUST be wrapped here.
  // Without disconnecting first, our own writes trigger the observer callback,
  // which writes again — the infinite loop that froze the page in v1.

  const OBSERVER_OPTS = {
    childList: true,  // watch for new message/paragraph/li nodes being inserted
    subtree:   true,
    // characterData intentionally omitted — see v1 bug note above.
  };

  function withObserverPaused(fn) {
    if (domObserver) domObserver.disconnect();
    try {
      fn();
    } finally {
      if (domObserver && enabled) {
        domObserver.observe(document.body, OBSERVER_OPTS);
      }
    }
  }

  // ─── Core stamping ──────────────────────────────────────────────────────────

  /**
   * Apply the correct dir attribute to a block-level element (p or li).
   *
   * Skip conditions:
   *  1. Text too short to classify.
   *  2. Text unchanged since last stamp AND dir attribute already present.
   *  3. RTL LOCK: element is inside an active stream and is already dir="rtl" —
   *     don't flip it back to LTR/auto on partial text. Direction moves
   *     LTR->RTL during streaming only, never RTL->LTR.
   *  4. The dir value we'd write already matches what's there (no-op write guard).
   */
  function stampBlock(el) {
    const text = (el.textContent || '').trim();
    if (text.length < CONFIG.minTextLength) return;

    // Fast path: nothing changed.
    if (cache.get(el) === text && el.hasAttribute('dir')) return;
    cache.set(el, text);

    const newDir = rtlRatio(text) >= CONFIG.rtlThreshold ? 'rtl' : 'auto';
    const currentDir = el.getAttribute('dir');

    // RTL lock: while this element is inside an active stream, once it has been
    // set RTL we never flip it back. Eliminates LTR<->RTL flickering on partial
    // sentences. The lock naturally lifts when streaming ends and the element is
    // no longer inside [data-is-streaming].
    if (currentDir === 'rtl' && newDir !== 'rtl' && isInsideStream(el)) {
      return;
    }

    // Guard the write — each setAttribute is itself a DOM mutation.
    if (currentDir !== newDir) {
      el.setAttribute('dir', newDir);
    }

    el.style.setProperty('unicode-bidi', 'plaintext', 'important');

    if (newDir === 'rtl') el.style.setProperty('text-align', 'right', 'important');
    else                  el.style.removeProperty('text-align');
  }

  /**
   * The ProseMirror editor always gets dir="auto" so layout and caret direction
   * flip automatically as the user switches between scripts.
   * Its child <p> AND <li> elements are stamped individually.
   *
   * BUG 1 FIX: added 'li' so list items typed by the user get correct direction.
   */
  function stampEditor(editor) {
    if (!editor) return;
    if (editor.getAttribute('dir') !== 'auto') {
      editor.setAttribute('dir', 'auto');
    }
    editor.style.setProperty('unicode-bidi', 'plaintext', 'important');
    editor.querySelectorAll('p, li').forEach(stampBlock);
  }

  // ─── Selectors ──────────────────────────────────────────────────────────────
  //
  // BUG 1 FIX: added `li` variants alongside every `p` variant so that numbered
  // and bulleted list items in Claude's responses are stamped individually.
  // Each <li> is checked for its own dominant language, not just the parent <ol>/<ul>.

  const SEL = {
    editors: [
      'div[contenteditable="true"]',
      '.ProseMirror',
    ].join(', '),

    blocks: [
      // Claude response paragraphs and list items
      '.font-claude-message p',
      '.font-claude-message li',
      '.prose p',
      '.prose li',
      // Streaming response paragraphs and list items
      '[data-is-streaming] p',
      '[data-is-streaming] li',
      // User message paragraphs and list items
      '.font-user-message p',
      '.font-user-message li',
      '.font-user-message',
      // Broad fallback
      'main p',
      'main li',
    ].join(', '),
  };

  // ─── Processing passes ───────────────────────────────────────────────────────

  // Called by the INPUT listener only (typing path — editor only).
  function processEditors() {
    document.querySelectorAll(SEL.editors).forEach(stampEditor);
  }

  // Called by the observer and on init/navigation (new content path).
  function processBlocks() {
    document.querySelectorAll(SEL.blocks).forEach(function (el) {
      if (el.closest('pre, code, .code-block, [class*="code"]')) return;
      stampBlock(el);
    });
  }

  // ─── Input listener — typing path ───────────────────────────────────────────

  const onInput = debounce(function () {
    if (!enabled) return;
    withObserverPaused(processEditors);
  }, CONFIG.inputDebounceMs);

  document.addEventListener('input', function (e) {
    if (enabled && e.target && e.target.isContentEditable) {
      onInput();
    }
  }, true); // capture phase: runs before React's synthetic event handlers

  // ─── MutationObserver — new message / streaming path ────────────────────────
  //
  // BUG 2 FIX: two debounced handlers at different delays.
  //   onNewNodesNormal   — used when nothing is streaming (fast, 250ms)
  //   onNewNodesStreaming — used while Claude is streaming (slow, 600ms)
  //
  // The slower debounce lets text accumulate before direction is evaluated,
  // so the ratio is stable by the time stampBlock runs. Combined with the
  // RTL lock in stampBlock, flickering is eliminated.

  function runProcessing() {
    if (!enabled) return;
    withObserverPaused(function () {
      processEditors();
      processBlocks();
    });
  }

  const onNewNodesNormal    = debounce(runProcessing, CONFIG.observerDebounceMs);
  const onNewNodesStreaming  = debounce(runProcessing, CONFIG.streamingDebounceMs);

  function startObserver() {
    if (domObserver) domObserver.disconnect();

    domObserver = new MutationObserver(function (mutations) {
      if (!enabled) return;
      var hasNewNodes = mutations.some(function (m) { return m.addedNodes.length > 0; });
      if (!hasNewNodes) return;

      // Route to the appropriate debounce based on whether streaming is active.
      if (isStreamingActive()) {
        onNewNodesStreaming();
      } else {
        onNewNodesNormal();
      }
    });

    domObserver.observe(document.body, OBSERVER_OPTS);
  }

  function stopObserver() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
  }

  // ─── SPA navigation ─────────────────────────────────────────────────────────

  const onNavigate = debounce(function () {
    if (!enabled) return;
    withObserverPaused(function () {
      processEditors();
      processBlocks();
    });
  }, CONFIG.navDebounceMs);

  var _origPushState = history.pushState.bind(history);
  history.pushState = function () {
    _origPushState.apply(history, arguments);
    onNavigate();
  };
  window.addEventListener('popstate', onNavigate);

  // ─── Enable / disable ────────────────────────────────────────────────────────

  function setEnabled(value) {
    enabled = !!value;

    if (enabled) {
      withObserverPaused(function () {
        processEditors();
        processBlocks();
      });
      startObserver();
    } else {
      stopObserver();
      document.querySelectorAll('[dir="rtl"], [dir="auto"]').forEach(function (el) {
        el.removeAttribute('dir');
        el.style.removeProperty('unicode-bidi');
        el.style.removeProperty('text-align');
        cache.delete(el);
      });
    }
  }

  // ─── Popup <-> content script messaging ─────────────────────────────────────

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    switch (msg.type) {
      case 'GET_STATE':
        sendResponse({ enabled: enabled });
        break;
      case 'SET_ENABLED':
        setEnabled(msg.enabled);
        chrome.storage.local.set({ [CONFIG.storageKey]: msg.enabled });
        sendResponse({ ok: true });
        break;
    }
    return true;
  });

  // ─── Init ────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(CONFIG.storageKey, function (result) {
    var shouldEnable = result[CONFIG.storageKey] !== false;
    enabled = shouldEnable;
    if (shouldEnable) {
      withObserverPaused(function () {
        processEditors();
        processBlocks();
      });
      startObserver();
    }
  });

})();
