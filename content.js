/**
 * Claude.ai RTL Fix — Content Script
 *
 * Strategy:
 *   1. Apply dir="auto" to the chat editor so direction shifts naturally as the
 *      user types Arabic/Hebrew vs. Latin characters.
 *   2. For each message paragraph, count the ratio of RTL code points to total
 *      letter code points. If >= RTL_THRESHOLD, set dir="rtl". Otherwise use
 *      dir="auto" and let the browser's Unicode Bidi Algorithm (UBA) decide.
 *   3. A MutationObserver watches ONLY for new nodes (new messages), not for
 *      character data changes. Typing is handled exclusively by the input listener.
 *   4. All DOM writes are wrapped in withObserverPaused() to prevent our own
 *      setAttribute/style calls from re-triggering the observer (infinite loop).
 *   5. Mixed content (English words, numbers, math) inside RTL paragraphs is
 *      handled automatically by the UBA — no extra logic required.
 *   6. Code blocks always stay LTR (enforced via styles.css).
 *
 * ── What was crashing the page ──────────────────────────────────────────────
 *
 *  BUG 1 — Infinite observer loop (the main crash):
 *    The old observer used `characterData: true` on document.body. Every
 *    keystroke fired the observer → stampBlock() called setAttribute/style →
 *    those DOM writes fired the observer again → infinite loop → page freeze.
 *    FIX: Remove characterData from observer options entirely. The input
 *    listener handles typing; the observer only needs structural changes.
 *
 *  BUG 2 — Double-trigger on every keystroke:
 *    Both the input listener AND the observer called processEditors() on each
 *    key, creating two overlapping feedback paths.
 *    FIX: Observer reacts only to addedNodes. Input listener owns editor updates.
 *
 *  BUG 3 — Unconditional DOM writes amplifying mutations:
 *    stampBlock() wrote setAttribute and style.setProperty even when direction
 *    hadn't changed, generating extra mutations for the observer to react to.
 *    FIX: Cache each element's last-seen text; skip when nothing changed.
 *    Guard attribute writes with getAttribute('dir') !== newDir before writing.
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

    // Debounce for the MutationObserver callback (new message nodes).
    observerDebounceMs: 250,

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

  const RTL_RE    = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿ‏‫יִ-ﭏﭐ-﷿ﹰ-﻿]/g;
  const LETTER_RE = /\p{L}/gu;

  // ─── State ──────────────────────────────────────────────────────────────────

  let enabled     = true;
  let domObserver = null;

  // Cache: element -> last textContent string we processed.
  // Lets stampBlock skip the regex when text hasn't changed,
  // AND correctly re-processes after disable/re-enable (see el.hasAttribute guard).
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

  // ─── Observer pause / resume ─────────────────────────────────────────────────
  //
  // Every DOM write (setAttribute, style.setProperty) MUST be wrapped here.
  // Without disconnecting first, our own writes trigger the observer callback,
  // which writes again, which triggers again — the infinite loop that froze the page.

  const OBSERVER_OPTS = {
    childList: true,   // watch for new message/paragraph nodes being inserted
    subtree:   true,
    // *** characterData is intentionally omitted ***
    // With characterData: true, every keystroke fires the observer because
    // ProseMirror updates text nodes on each character. That callback then
    // calls setAttribute which fires the observer again. Removing this option
    // is the single most important fix. The input listener covers typing.
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
   * Apply the correct dir attribute to a block-level element.
   *
   * Skip conditions (prevent unnecessary DOM writes):
   *  1. Text too short to classify.
   *  2. Text unchanged since last stamp AND dir attribute already present
   *     (common case: observer fires on a node we already handled).
   *  3. The dir value we'd write matches what's already there.
   */
  function stampBlock(el) {
    const text = (el.textContent || '').trim();
    if (text.length < CONFIG.minTextLength) return;

    // Fast path: text hasn't changed and we already set a dir — skip entirely.
    // el.hasAttribute('dir') guard ensures re-enable after disable works correctly.
    if (cache.get(el) === text && el.hasAttribute('dir')) return;
    cache.set(el, text);

    const newDir = rtlRatio(text) >= CONFIG.rtlThreshold ? 'rtl' : 'auto';

    // Only write setAttribute if the value would actually change.
    // Each setAttribute call is itself a DOM mutation; guard it to stay quiet.
    if (el.getAttribute('dir') !== newDir) {
      el.setAttribute('dir', newDir);
    }

    el.style.setProperty('unicode-bidi', 'plaintext', 'important');

    if (newDir === 'rtl') el.style.setProperty('text-align', 'right', 'important');
    else                  el.style.removeProperty('text-align');
  }

  /**
   * The ProseMirror editor always gets dir="auto" so layout and caret direction
   * flip automatically as the user switches between scripts.
   * Its child <p> elements are stamped individually for per-paragraph direction.
   */
  function stampEditor(editor) {
    if (!editor) return;
    if (editor.getAttribute('dir') !== 'auto') {
      editor.setAttribute('dir', 'auto');
    }
    editor.style.setProperty('unicode-bidi', 'plaintext', 'important');
    editor.querySelectorAll('p').forEach(stampBlock);
  }

  // ─── Selectors ──────────────────────────────────────────────────────────────

  const SEL = {
    editors: [
      'div[contenteditable="true"]',
      '.ProseMirror',
    ].join(', '),

    blocks: [
      '.font-claude-message p',
      '.prose p',
      '[data-is-streaming] p',
      '.font-user-message p',
      '.font-user-message',
      'main p',
    ].join(', '),
  };

  // ─── Processing passes ───────────────────────────────────────────────────────

  // Called by the INPUT listener only (typing path).
  // Does not touch message blocks — only the active editor.
  function processEditors() {
    document.querySelectorAll(SEL.editors).forEach(stampEditor);
  }

  // Called by the OBSERVER and on init/navigation (new content path).
  function processBlocks() {
    document.querySelectorAll(SEL.blocks).forEach(el => {
      if (el.closest('pre, code, .code-block, [class*="code"]')) return;
      stampBlock(el);
    });
  }

  // ─── Input listener — typing path ───────────────────────────────────────────
  //
  // This is the ONLY path that runs while the user is typing.
  // The MutationObserver is NOT involved in handling keystrokes.
  // That separation is what prevents the feedback loop.

  const onInput = debounce(function () {
    if (!enabled) return;
    withObserverPaused(processEditors);
  }, CONFIG.inputDebounceMs);

  document.addEventListener('input', function (e) {
    if (enabled && e.target && e.target.isContentEditable) {
      onInput();
    }
  }, true); // capture phase: runs before React's synthetic event handlers

  // ─── MutationObserver — new message path ────────────────────────────────────
  //
  // Fires only when new nodes are added (new message, streaming update, React
  // mount). Does NOT fire on character data changes — that's the input listener's job.

  const onNewNodes = debounce(function () {
    if (!enabled) return;
    withObserverPaused(function () {
      processEditors();
      processBlocks();
    });
  }, CONFIG.observerDebounceMs);

  function startObserver() {
    if (domObserver) domObserver.disconnect();

    domObserver = new MutationObserver(function (mutations) {
      if (!enabled) return;
      // Only act on structural changes. Text edits are the input listener's job.
      var hasNewNodes = mutations.some(function (m) { return m.addedNodes.length > 0; });
      if (hasNewNodes) {
        onNewNodes();
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
  //
  // Intercept history.pushState instead of running a second MutationObserver on
  // `document` — that second observer also fired on every keystroke and made
  // things worse.

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
      // Strip every dir/style we applied so Claude.ai reverts to its defaults.
      document.querySelectorAll('[dir="rtl"], [dir="auto"]').forEach(function (el) {
        el.removeAttribute('dir');
        el.style.removeProperty('unicode-bidi');
        el.style.removeProperty('text-align');
        // Remove from cache so re-enable re-processes the element from scratch.
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
    return true; // keep channel open for async sendResponse
  });

  // ─── Init ────────────────────────────────────────────────────────────────────

  chrome.storage.local.get(CONFIG.storageKey, function (result) {
    var shouldEnable = result[CONFIG.storageKey] !== false; // default: true
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
