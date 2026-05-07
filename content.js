(() => {
  "use strict";

  console.log("Extension Loaded");

  const SIDEBAR_ID = "cgpt-sidebar";
  const LIST_ID    = "cgpt-sidebar-list";
  const TOGGLE_ID  = "cgpt-sidebar-toggle";
  const TEXT_LIMIT = 90;
  const MAX_RENDER = 300;

  // ── Utilities ────────────────────────────────────────────────

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ── Cached refs ───────────────────────────────────────────────

  let $sidebar = null;
  let $list    = null;
  let $toggle  = null;

  // ── Message Registry ──────────────────────────────────────────
  // Single source of truth: msgId → { chatEl, sidebarEl, index }
  // Built incrementally, never rebuilt from scratch unless reset.

  const registry = new Map(); // msgId → { chatEl, sidebarEl, index }

  function getRegistryEntry(msgId) { return registry.get(msgId); }

  // ── Debug ─────────────────────────────────────────────────────

  const DEBUG = false; // set true to enable verbose console logging
  function log(...args)  { if (DEBUG) console.log("[Navigator]", ...args); }
  function warn(...args) { if (DEBUG) console.warn("[Navigator]", ...args); }

  // ── Message Detection ─────────────────────────────────────────
  //
  // Selector chain tried in order — first one that returns user messages wins.
  // Each strategy is isolated in a try/catch so one bad selector never
  // silences the others.
  //
  // After a successful match the result is cached until invalidateCache()
  // is called by the MutationObserver. If ALL strategies return 0 nodes,
  // cachedNodes is left as null (not []) so the next observer fire retries
  // instead of permanently returning empty.

  let cachedNodes      = null;
  let emptyRetryTimer  = null; // retry after short delay when 0 found

  function invalidateCache() { cachedNodes = null; }

  // Shared post-filter: remove hidden elements, empty text, and any node
  // that belongs to our own sidebar (prevents self-detection loops).
  function filterNodes(nodes) {
    return nodes.filter(el => {
      if (!el || !el.isConnected) return false;
      // Skip our own injected sidebar elements
      if (el.closest(`#${SIDEBAR_ID}`)) return false;
      // Skip visually hidden nodes
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      // Must have non-empty text
      return (el.textContent || "").trim().length > 0;
    });
  }

  function queryUserMessages() {
    if (cachedNodes !== null) return cachedNodes;

    let nodes = [];

    // ── Strategy 1: explicit role attribute (most reliable) ──
    try {
      nodes = filterNodes(Array.from(
        document.querySelectorAll('[data-message-author-role="user"]')
      ));
      if (nodes.length) {
        log(`Messages Found: ${nodes.length} (data-message-author-role)`);
        return (cachedNodes = nodes);
      }
    } catch (e) { /* selector unsupported — skip */ }

    // ── Strategy 2: data-testid on article elements ──
    // ChatGPT uses data-testid="conversation-turn-N" where even N = user
    // in some builds. We grab all turns and filter by absence of assistant marker.
    try {
      const turns = Array.from(
        document.querySelectorAll('article[data-testid^="conversation-turn-"]')
      );
      nodes = filterNodes(turns.filter(el =>
        !el.querySelector('[data-message-author-role="assistant"]') &&
        !el.querySelector('[class*="markdown"]') &&
        !el.querySelector('[class*="prose"]')
      ));
      if (nodes.length) {
        log(`Messages Found: ${nodes.length} (article[data-testid])`);
        return (cachedNodes = nodes);
      }
    } catch (e) { /* skip */ }

    // ── Strategy 3: div[data-message-author-role] any value, filter to user ──
    try {
      nodes = filterNodes(Array.from(
        document.querySelectorAll('div[data-message-author-role="user"]')
      ));
      if (nodes.length) {
        log(`Messages Found: ${nodes.length} (div[data-message-author-role=user])`);
        return (cachedNodes = nodes);
      }
    } catch (e) { /* skip */ }

    // ── Strategy 4: main article — structural fallback ──
    try {
      const articles = Array.from(document.querySelectorAll("main article"));
      nodes = filterNodes(articles.filter(el =>
        !el.querySelector('[data-message-author-role="assistant"]') &&
        !el.querySelector('[class*="markdown"]') &&
        !el.querySelector('[class*="prose"]')
      ));
      if (nodes.length) {
        log(`Messages Found: ${nodes.length} (main article)`);
        return (cachedNodes = nodes);
      }
    } catch (e) { /* skip */ }

    // ── Strategy 5: main [data-testid*="conversation"] ──
    try {
      nodes = filterNodes(Array.from(
        document.querySelectorAll('main [data-testid*="conversation-turn"]')
      ).filter(el =>
        !el.querySelector('[data-message-author-role="assistant"]') &&
        !el.querySelector('[class*="markdown"]')
      ));
      if (nodes.length) {
        log(`Messages Found: ${nodes.length} (main [data-testid*=conversation-turn])`);
        return (cachedNodes = nodes);
      }
    } catch (e) { /* skip */ }

    // ── Strategy 6: .group heuristic (older ChatGPT builds) ──
    try {
      nodes = filterNodes(Array.from(
        document.querySelectorAll("main .group")
      ).filter(el =>
        !el.querySelector('[class*="markdown"]') &&
        !el.querySelector('[class*="prose"]') &&
        (el.textContent || "").trim().length > 10
      ));
      if (nodes.length) {
        log(`Messages Found: ${nodes.length} (main .group)`);
        return (cachedNodes = nodes);
      }
    } catch (e) { /* skip */ }

    // ── All strategies failed ──
    // Leave cachedNodes = null so next observer fire retries automatically.
    // Schedule a one-shot retry in 1.5s in case the page is still hydrating.
    if (!emptyRetryTimer) {
      emptyRetryTimer = setTimeout(() => {
        emptyRetryTimer = null;
        invalidateCache();
        extractQuestions();
      }, 1500);
    }

    warn("Messages Found: 0 — all selectors failed. Page may still be loading.");
    return [];
  }

  function extractText(el) {
    return (el.textContent || "").trim().slice(0, TEXT_LIMIT);
  }

  // ── Rendering ─────────────────────────────────────────────────

  function createListItem(msgId, text, displayNumber) {
    const item = document.createElement("button");
    item.className     = "cgpt-nav-item";
    item.dataset.msgId = msgId;
    item.title         = text;

    item.addEventListener("click", () => handleItemClick(msgId));

    const badge = document.createElement("span");
    badge.className   = "msg-index";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = displayNumber;

    const span = document.createElement("span");
    span.className   = "cgpt-item-text";
    span.textContent = text;

    item.appendChild(badge);
    item.appendChild(span);
    return item;
  }

  function reindexList() {
    requestAnimationFrame(() => {
      const items  = $list.querySelectorAll(".cgpt-nav-item");
      const badges = Array.from(items).map(el => el.querySelector(".msg-index"));
      badges.forEach((b, i) => { if (b) b.textContent = i + 1; });
    });
  }

  // ── Load More ─────────────────────────────────────────────────

  let $loadMoreBtn = null;

  function showLoadMore(count) {
    if ($loadMoreBtn) { $loadMoreBtn.textContent = `+ ${count} more messages`; return; }
    $loadMoreBtn = document.createElement("button");
    $loadMoreBtn.className   = "cgpt-load-more";
    $loadMoreBtn.textContent = `+ ${count} more messages`;
    $loadMoreBtn.addEventListener("click", renderNextBatch);
    $list.after($loadMoreBtn);
  }

  function hideLoadMore() {
    if ($loadMoreBtn) { $loadMoreBtn.remove(); $loadMoreBtn = null; }
  }

  // ── Extraction ────────────────────────────────────────────────

  let lastSnapshot = [];
  let rafPending   = false;

  const extractQuestions = debounce(() => {
    try {
      if (!$list) return;

      const nodes   = queryUserMessages();
      const capped  = nodes.length > MAX_RENDER;
      const work    = capped ? nodes.slice(0, MAX_RENDER) : nodes;

      const snapshot = work.map((el, i) => ({
        id:   `msg-${i}`,
        text: extractText(el),
        el,
        i,
      }));

      // Nothing changed — skip
      if (
        snapshot.length === lastSnapshot.length &&
        snapshot.every((s, i) => s.text === lastSnapshot[i]?.text)
      ) return;

      // Patch changed text in existing items (streaming edits)
      const patches = [];
      snapshot.forEach((s, i) => {
        if (i < lastSnapshot.length && s.text !== lastSnapshot[i].text) {
          const entry = getRegistryEntry(s.id);
          if (entry) patches.push({ entry, text: s.text });
        }
      });

      if (patches.length > 0) {
        requestAnimationFrame(() => {
          patches.forEach(({ entry, text }) => {
            const span = entry.sidebarEl.querySelector(".cgpt-item-text");
            if (span) span.textContent = text;
            entry.sidebarEl.title = text;
          });
        });
      }

      // Append new items via DocumentFragment — single reflow
      const newEntries = snapshot.slice(lastSnapshot.length);

      if (newEntries.length > 0 && !rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          const fragment = document.createDocumentFragment();

          newEntries.forEach(s => {
            if (registry.has(s.id)) return; // duplicate guard

            const sidebarEl = createListItem(s.id, s.text, s.i + 1);
            fragment.appendChild(sidebarEl);

            // Register stable mapping: msgId → { chatEl, sidebarEl, index }
            registry.set(s.id, { chatEl: s.el, sidebarEl, index: s.i });

            // Stamp chat element and start observing it
            s.el.dataset.cgptMsgId = s.id;
            if (intersectionObs) intersectionObs.observe(s.el);
          });

          if (fragment.childElementCount > 0) {
            $list.appendChild(fragment);
            if (newEntries.length > 0) reindexList();
          }
        });
      }

      lastSnapshot = snapshot;

      if (capped) showLoadMore(nodes.length - MAX_RENDER);
      else hideLoadMore();

      log(`Sidebar items: ${registry.size}${capped ? ` (+${nodes.length - MAX_RENDER} hidden)` : ""}`);
    } catch (e) {
      console.error("Extension Error (extractQuestions):", e);
    }
  }, 300);

  function renderNextBatch() {
    const nodes      = queryUserMessages();
    const batchStart = lastSnapshot.length;
    const batchEnd   = Math.min(batchStart + 50, nodes.length);

    requestAnimationFrame(() => {
      const fragment = document.createDocumentFragment();
      for (let i = batchStart; i < batchEnd; i++) {
        const el  = nodes[i];
        const id  = `msg-${i}`;
        if (registry.has(id)) continue;

        const text      = extractText(el);
        const sidebarEl = createListItem(id, text, i + 1);
        fragment.appendChild(sidebarEl);
        registry.set(id, { chatEl: el, sidebarEl, index: i });
        el.dataset.cgptMsgId = id;
        if (intersectionObs) intersectionObs.observe(el);

        lastSnapshot.push({ id, text, el, i });
      }

      if (fragment.childElementCount > 0) {
        $list.appendChild(fragment);
        reindexList();
      }

      const remaining = nodes.length - lastSnapshot.length;
      if (remaining > 0) showLoadMore(remaining);
      else hideLoadMore();
    });
  }

  // ── Navigation ────────────────────────────────────────────────
  // isProgrammaticScroll suppresses IntersectionObserver during
  // click-initiated scrolls to prevent the observer from fighting
  // the click handler and causing highlight flicker.

  let isProgrammaticScroll = false;
  let programmaticScrollTimer = null;

  function handleItemClick(msgId) {
    const entry = getRegistryEntry(msgId);
    if (!entry) {
      warn(`Click: no registry entry for ${msgId}`);
      return;
    }

    log(`Click → msgId: ${msgId}, index: ${entry.index}`);

    // Suppress observer-driven highlight during programmatic scroll
    isProgrammaticScroll = true;
    clearTimeout(programmaticScrollTimer);

    // Immediately apply highlight so click feels instant
    setActive(msgId);

    entry.chatEl.scrollIntoView({ behavior: "smooth", block: "center" });

    // Re-enable observer after scroll animation completes (~800ms)
    programmaticScrollTimer = setTimeout(() => {
      isProgrammaticScroll = false;
    }, 800);

    if (window.innerWidth <= 768) closeSidebar();
  }

  // ── Active Highlighting ───────────────────────────────────────

  let activeId = null;

  function setActive(msgId) {
    if (msgId === activeId) return;

    // Deactivate previous — direct DOM write, no rAF needed (single element)
    if (activeId) {
      const prev = getRegistryEntry(activeId);
      if (prev) prev.sidebarEl.classList.remove("cgpt-nav-item--active");
    }

    // Activate new
    const next = getRegistryEntry(msgId);
    if (next) {
      next.sidebarEl.classList.add("cgpt-nav-item--active");
      next.sidebarEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
      log(`Active → msgId: ${msgId}, index: ${next.index}`);
    }

    activeId = msgId;
  }

  // ── IntersectionObserver ──────────────────────────────────────

  let intersectionObs = null;

  function startIntersectionObserver() {
    intersectionObs = new IntersectionObserver((entries) => {
      // Skip while a programmatic scroll is in progress
      if (isProgrammaticScroll) return;

      // Pick the entry with the highest visibility ratio
      let best = null;
      entries.forEach(entry => {
        if (
          entry.isIntersecting &&
          (!best || entry.intersectionRatio > best.intersectionRatio)
        ) best = entry;
      });

      if (best) {
        const msgId = best.target.dataset.cgptMsgId;
        if (msgId) setActive(msgId);
      }
    }, { root: null, threshold: [0.3, 0.6] });
  }

  function unobserveAll() {
    if (intersectionObs) intersectionObs.disconnect();
    registry.clear();
    activeId = null;
  }

  // ── MutationObserver ──────────────────────────────────────────

  let mutationObs = null;

  function getChatContainer() {
    return document.querySelector("main") ||
           document.querySelector('[role="main"]') ||
           document.querySelector(".overflow-y-auto") ||
           document.body;
  }

  function startObserver() {
    if (mutationObs) return;
    const target = getChatContainer();
    mutationObs = new MutationObserver(() => {
      invalidateCache();
      extractQuestions();
    });
    mutationObs.observe(target, { childList: true, subtree: true });
    log("MutationObserver attached to:", target.tagName);
  }

  // ── SPA Navigation ────────────────────────────────────────────

  function resetState() {
    if ($list) $list.innerHTML = "";
    hideLoadMore();
    lastSnapshot         = [];
    rafPending           = false;
    isProgrammaticScroll = false;
    clearTimeout(programmaticScrollTimer);
    clearTimeout(emptyRetryTimer);
    emptyRetryTimer = null;
    unobserveAll();
    invalidateCache();
    startIntersectionObserver();
  }

  function watchNavigation() {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      console.log("[Navigator] Navigation detected, resetting...");
      setTimeout(() => {
        try { resetState(); extractQuestions(); }
        catch (e) { console.error("Extension Error (watchNavigation):", e); }
      }, 800);
    }, 1000);
  }
  // ── Theme ─────────────────────────────────────────────────────

  function applyTheme() {
    if (!$sidebar) return;
    $sidebar.dataset.theme =
      document.documentElement.classList.contains("dark") ? "dark" : "light";
  }

  function startThemeObserver() {
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true, attributeFilter: ["class"],
    });
  }

  // ── Sidebar UI ────────────────────────────────────────────────

  function createSidebar() {
    if (document.getElementById(SIDEBAR_ID)) {
      $sidebar = document.getElementById(SIDEBAR_ID);
      $list    = document.getElementById(LIST_ID);
      return;
    }
    const sidebar = document.createElement("div");
    sidebar.id = SIDEBAR_ID;
    sidebar.setAttribute("role", "navigation");
    sidebar.setAttribute("aria-label", "Chat Navigator");
    sidebar.innerHTML = `
      <div class="cgpt-sidebar-header"><span>Navigator</span></div>
      <div id="${LIST_ID}" class="cgpt-nav-list" role="list"></div>
    `;
    document.body.appendChild(sidebar);
    $sidebar = sidebar;
    $list    = sidebar.querySelector(`#${LIST_ID}`);
    console.log("Sidebar Created");
  }

  function createToggleButton() {
    if (document.getElementById(TOGGLE_ID)) {
      $toggle = document.getElementById(TOGGLE_ID);
      return;
    }
    const btn = document.createElement("button");
    btn.id    = TOGGLE_ID;
    btn.title = "Toggle Sidebar";
    btn.setAttribute("aria-label", "Toggle navigation sidebar");
    btn.textContent = "☰";
    btn.addEventListener("click", toggleSidebar);
    document.body.appendChild(btn);
    $toggle = btn;
  }

  function openSidebar() {
    if (!$sidebar || !$toggle) return;
    $sidebar.classList.remove("cgpt-sidebar--closed");
    $toggle.textContent = "✕";
    $toggle.setAttribute("aria-expanded", "true");
    chrome.storage.local.set({ sidebarOpen: true });
  }

  function closeSidebar() {
    if (!$sidebar || !$toggle) return;
    $sidebar.classList.add("cgpt-sidebar--closed");
    $toggle.textContent = "☰";
    $toggle.setAttribute("aria-expanded", "false");
    chrome.storage.local.set({ sidebarOpen: false });
  }

  function toggleSidebar() {
    if (!$sidebar) return;
    $sidebar.classList.contains("cgpt-sidebar--closed") ? openSidebar() : closeSidebar();
  }

  // ── Init ──────────────────────────────────────────────────────

  function init() {
    try {
      if (!document.body) { window.addEventListener("load", init); return; }
      createSidebar();
      createToggleButton();
      applyTheme();
      startThemeObserver();
      chrome.storage.local.get("sidebarOpen", ({ sidebarOpen }) => {
        sidebarOpen === false ? closeSidebar() : openSidebar();
      });
      startIntersectionObserver();
      extractQuestions();
      startObserver();
      watchNavigation();
    } catch (e) {
      console.error("Extension Error (init):", e);
    }
  }

  init();
})();
