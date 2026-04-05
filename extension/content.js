/**
 * NeuroAdapt — cognitive accessibility (toolbar-toggle widget, bounded analysis, safe AI).
 */
(() => {
  "use strict";

  const PANEL_ID = "neuroadapt-panel";
  /** Viewport-fixed host; must stay a direct child of body (never inside page layout). */
  const WIDGET_HOST_ID = "neuroadapt-widget";

  const LS = {
    fixClicks: "neuroadapt_v1_fix_clicks",
    preferredMode: "neuroadapt_v1_preferred_mode",
    simplificationLevel: "neuroadapt_v1_simplification_level",
    autoHighLoad: "neuroadapt_v1_auto_high_load",
    neuroProfile: "neuroadapt_v1_neuro_profile",
    bionicAnchors: "neuroadapt_v1_bionic_anchors"
  };

  /** Widget + prefs (maps to spec: isOpen, isCollapsed, position, side, focusStripEnabled, …) */
  const UI_LS = {
    isOpen: "neuroadapt_ui_is_open",
    collapsed: "neuroadapt_ui_collapsed",
    side: "neuroadapt_ui_side",
    x: "neuroadapt_ui_x",
    y: "neuroadapt_ui_y",
    theme: "neuroadapt_ui_theme",
    focusStrip: "neuroadapt_ui_focus_strip",
    comfortSpacing: "neuroadapt_ui_comfort_spacing",
    reduceMotion: "neuroadapt_ui_reduce_motion"
  };

  const Machine = {
    CLOSED: "closed",
    OPENING: "opening",
    OPEN: "open",
    COLLAPSED: "collapsed",
    SIMPLIFYING: "simplifying",
    ERROR: "error"
  };

  const MODES = {
    FOCUS: "focus",
    READING: "reading",
    QUICK_SCAN: "quick_scan"
  };

  const LEVELS = {
    LIGHT: "light",
    MEDIUM: "medium",
    AGGRESSIVE: "aggressive"
  };

  const LONG_WORD_THRESHOLD = 20;
  const HIGH_LOAD_THRESHOLD = 60;
  const FREQUENT_FIX_THRESHOLD = 3;
  const AI_MAX_CHARS = 3000;
  const AI_REQUEST_GAP_MS = 160;
  const MAX_SIMPLIFY_BLOCKS = 20;
  const ANALYSIS_TEXT_CAP = 20000;
  const DOM_ELEMENT_COUNT_CAP = 15000;
  const DENSE_BLOCK_P_MAX = 400;
  const HEURISTIC_TEXT_NODE_CAP = 800;
  const SECTION_CHAR_CAP = 1400;
  const AI_SECTION_TIMEOUT_MS = 8500;
  const OPEN_ANIM_MS = 220;

  /** @type {string} */
  let machineState = Machine.CLOSED;
  let simplifyGeneration = 0;
  let widgetWindowHooks = false;

  /** @type {{ startX: number, startY: number, origLeft: number, origTop: number } | null} */
  let uiDrag = null;
  /** @type {((e: PointerEvent) => void) | null} */
  let outsideDown = null;
  /** @type {((e: KeyboardEvent) => void) | null} */
  let escKey = null;

  const state = {
    baselineMetrics: null,
    transformed: false,
    lastTransformResult: null,
    panelElements: null,
    currentMode: MODES.FOCUS,
    simplificationLevel: LEVELS.MEDIUM
  };

  function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Keep the widget host as a direct child of document.body so `position: fixed`
   * stays viewport-anchored (nested under transformed/filter ancestors breaks fixed).
   */
  function mountWidgetHostToDocument(hostEl) {
    if (!hostEl) {
      return;
    }
    const body = document.body;
    if (body) {
      if (hostEl.parentNode !== body) {
        hostEl.remove();
        body.appendChild(hostEl);
      }
      return;
    }
    const de = document.documentElement;
    if (de && hostEl.parentNode !== de) {
      hostEl.remove();
      de.appendChild(hostEl);
    }
  }

  let ensureHostRaf = 0;
  function scheduleEnsureWidgetHost() {
    if (ensureHostRaf) {
      return;
    }
    ensureHostRaf = requestAnimationFrame(() => {
      ensureHostRaf = 0;
      mountWidgetHostToDocument(document.getElementById(WIDGET_HOST_ID));
    });
  }

  function normalizeTextContent(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function extensionRuntimeOk() {
    return typeof chrome !== "undefined" && chrome.runtime && Boolean(chrome.runtime.id);
  }

  function setMachineState(next) {
    machineState = next;
    const root = document.getElementById(WIDGET_HOST_ID);
    if (root) {
      root.dataset.state = next;
    }
  }

  const LearningAgent = {
    getFixClicks() {
      const v = parseInt(localStorage.getItem(LS.fixClicks) || "0", 10);
      return Number.isFinite(v) ? v : 0;
    },
    incrementFixClicks() {
      const n = this.getFixClicks() + 1;
      localStorage.setItem(LS.fixClicks, String(n));
      if (n === FREQUENT_FIX_THRESHOLD) {
        this.setAutoHighLoad(true);
      }
      return n;
    },
    getPreferredMode() {
      const m = localStorage.getItem(LS.preferredMode);
      if (m === MODES.READING || m === MODES.QUICK_SCAN || m === MODES.FOCUS) {
        return m;
      }
      return MODES.FOCUS;
    },
    setPreferredMode(mode) {
      if (mode === MODES.READING || mode === MODES.QUICK_SCAN || mode === MODES.FOCUS) {
        localStorage.setItem(LS.preferredMode, mode);
      }
    },
    getSimplificationLevel() {
      const l = localStorage.getItem(LS.simplificationLevel);
      if (l === LEVELS.LIGHT || l === LEVELS.MEDIUM || l === LEVELS.AGGRESSIVE) {
        return l;
      }
      return LEVELS.MEDIUM;
    },
    setSimplificationLevel(level) {
      if (level === LEVELS.LIGHT || level === LEVELS.MEDIUM || level === LEVELS.AGGRESSIVE) {
        localStorage.setItem(LS.simplificationLevel, level);
      }
    },
    getAutoHighLoad() {
      return localStorage.getItem(LS.autoHighLoad) === "1";
    },
    setAutoHighLoad(on) {
      localStorage.setItem(LS.autoHighLoad, on ? "1" : "0");
    },
    shouldAutoApplyFromHabit() {
      return this.getFixClicks() >= FREQUENT_FIX_THRESHOLD;
    },
    getNeuroProfile() {
      const p = localStorage.getItem(LS.neuroProfile);
      return ["default", "adhd", "autism", "dyslexia"].includes(p) ? p : "default";
    },
    setNeuroProfile(profile) {
      localStorage.setItem(LS.neuroProfile, profile);
      this.applyNeuroProfile(profile);
    },
    getBionicAnchors() {
      return localStorage.getItem(LS.bionicAnchors) === "1";
    },
    setBionicAnchors(on) {
      localStorage.setItem(LS.bionicAnchors, on ? "1" : "0");
      this.applyBionicAnchors(on);
    },
    applyNeuroProfile(profile) {
      document.body.classList.remove("neuroadapt-profile-adhd", "neuroadapt-profile-autism", "neuroadapt-profile-dyslexia");
      if (profile !== "default") {
        document.body.classList.add(`neuroadapt-profile-${profile}`);
      }
    },
    applyBionicAnchors(on) {
      if (on) {
        document.body.classList.add("neuroadapt-bionic-active");
      } else {
        document.body.classList.remove("neuroadapt-bionic-active");
      }
    }
  };

  const AnalyzerAgent = {
    splitIntoSentences(text) {
      if (!text || !text.trim()) {
        return [];
      }
      const normalized = text.replace(/\s+/g, " ").trim();
      const parts = normalized.split(/(?<=[.!?…])\s+/);
      const out = parts.map((s) => s.trim()).filter(Boolean);
      return out.length ? out : [normalized];
    },

    wordCount(sentence) {
      return sentence.split(/\s+/).filter(Boolean).length;
    },

    extractVisibleText() {
      const raw = normalizeTextContent(document.body?.textContent || "");
      return raw.length > ANALYSIS_TEXT_CAP ? raw.slice(0, ANALYSIS_TEXT_CAP) : raw;
    },

    getDOMElementCount() {
      const root = document.body;
      if (!root) {
        return 0;
      }
      let n = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
      while (walker.nextNode()) {
        n += 1;
        if (n >= DOM_ELEMENT_COUNT_CAP) {
          return DOM_ELEMENT_COUNT_CAP;
        }
      }
      return n;
    },

    detectDenseTextBlocks() {
      const candidates = document.querySelectorAll("p");
      let denseBlockCount = 0;
      let maxBlockWords = 0;
      const limit = Math.min(candidates.length, DENSE_BLOCK_P_MAX);

      for (let i = 0; i < limit; i += 1) {
        const el = candidates[i];
        if (el.closest(`#${PANEL_ID}`) || el.closest(`#${WIDGET_HOST_ID}`)) {
          continue;
        }
        const t = normalizeTextContent(el.textContent || "");
        const words = t ? t.split(/\s+/).length : 0;
        if (words >= 220) {
          denseBlockCount += 1;
          maxBlockWords = Math.max(maxBlockWords, words);
        }
      }

      return { denseBlockCount, maxBlockWords };
    },

    analyzePage() {
      const text = this.extractVisibleText();
      const sentences = this.splitIntoSentences(text);
      const words = text ? text.split(/\s+/).filter(Boolean) : [];
      const totalSentences = sentences.length || 1;
      const avgWordsPerSentence = words.length / totalSentences;

      let longSentenceCount = 0;
      sentences.forEach((s) => {
        if (this.wordCount(s) > LONG_WORD_THRESHOLD) {
          longSentenceCount += 1;
        }
      });

      const domElementCount = this.getDOMElementCount();
      const { denseBlockCount, maxBlockWords } = this.detectDenseTextBlocks();

      return {
        text,
        sentences,
        words,
        avgWordsPerSentence,
        longSentenceCount,
        domElementCount,
        denseBlockCount,
        maxBlockWords,
        totalSentences: sentences.length
      };
    }
  };

  const ScoringAgent = {
    score(features) {
      const raw =
        features.avgWordsPerSentence +
        features.domElementCount / 100 +
        features.longSentenceCount;

      const score = Number(raw.toFixed(2));
      let category = "Low";
      if (score >= 60) {
        category = "High";
      } else if (score > 30) {
        category = "Medium";
      }
      return { score, category };
    }
  };

  const ExplanationAgent = {
    buildNarrative(features) {
      const parts = [];
      if (features.domElementCount > 1400) {
        parts.push("many elements competing for attention");
      } else if (features.domElementCount > 800) {
        parts.push("a busy layout with lots of on-screen structure");
      }
      if (features.longSentenceCount > 6) {
        parts.push("many long sentences that slow reading");
      } else if (features.longSentenceCount > 0) {
        parts.push("some long sentences that increase reading effort");
      }
      if (features.avgWordsPerSentence > 22) {
        parts.push("dense wording (high average words per sentence)");
      } else if (features.avgWordsPerSentence > 16) {
        parts.push("moderately dense phrasing");
      }
      if (features.denseBlockCount > 0) {
        parts.push("large uninterrupted text blocks");
      }
      if (!parts.length) {
        return "This page feels relatively easy to scan, with shorter sentences and lighter structure.";
      }
      return `This page may feel demanding because it has ${parts.join(", ")}.`;
    },

    buildBulletReasons(features) {
      const bullets = [];
      if (features.domElementCount > 1200) {
        bullets.push("High DOM complexity → visual clutter and more things to track.");
      } else if (features.domElementCount > 700) {
        bullets.push("Elevated DOM size → moderately cluttered layout.");
      }
      if (features.longSentenceCount > 0) {
        bullets.push(
          `Long sentences (more than ${LONG_WORD_THRESHOLD} words): ${features.longSentenceCount} → higher working-memory load.`
        );
      }
      if (features.avgWordsPerSentence > 18) {
        bullets.push(
          `High average words per sentence (${features.avgWordsPerSentence.toFixed(1)}) → denser prose.`
        );
      }
      if (features.denseBlockCount > 0) {
        bullets.push(`Dense text blocks (${features.denseBlockCount}) → harder to scan.`);
      }
      if (!bullets.length) {
        bullets.push("No major structural red flags in this snapshot.");
      }
      return bullets;
    }
  };

  const ContentExtractorAgent = {
    isNoiseElement(el) {
      if (!el?.closest) {
        return true;
      }
      if (el.closest(`#${PANEL_ID}`) || el.closest(`#${WIDGET_HOST_ID}`)) {
        return true;
      }
      if (
        el.closest(
          "nav, footer, aside, header, [role='navigation'], [role='banner'], [role='contentinfo']"
        )
      ) {
        return true;
      }
      const adHint = /(^|-)(ad|ads|advert|banner|sponsor|promo|social|share)(-|$)/i;
      const cls = typeof el.className === "string" ? el.className : "";
      if (el.id && adHint.test(el.id)) {
        return true;
      }
      if (cls && adHint.test(cls)) {
        return true;
      }
      return false;
    },

    getMainRoot() {
      const candidates = [
        document.querySelector("main"),
        document.querySelector("article"),
        document.querySelector("[role='main']"),
        document.querySelector("#mw-content-text"),
        document.querySelector("#content article"),
        document.querySelector(".post-content"),
        document.querySelector("#content")
      ].filter(Boolean);
      const ok = candidates.find((n) => n && !n.closest(`#${PANEL_ID}`));
      return ok || document.body;
    },

    paragraphNeedsLLM(text) {
      const trimmed = text.replace(/\s+/g, " ").trim();
      if (trimmed.length < 50) {
        return false;
      }
      const sentences = AnalyzerAgent.splitIntoSentences(trimmed);
      const hasLong = sentences.some((s) => AnalyzerAgent.wordCount(s) > LONG_WORD_THRESHOLD);
      const words = trimmed.split(/\s+/).filter(Boolean).length;
      return hasLong || words >= 120;
    },

    getParagraphsToSimplify(maxBlocks = MAX_SIMPLIFY_BLOCKS, rootOverride = null) {
      const root = rootOverride || this.getMainRoot();
      const nodes = root.querySelectorAll("p");
      const out = [];
      nodes.forEach((el) => {
        if (this.isNoiseElement(el)) {
          return;
        }
        const t = normalizeTextContent(el.textContent || "");
        if (!this.paragraphNeedsLLM(t)) {
          return;
        }
        out.push(el);
      });
      return out.slice(0, maxBlocks);
    }
  };

  const SimplificationAgent = {
    phraseMaps: {
      aggressive: [
        ["in order to", "to"],
        ["at this point in time", "now"],
        ["due to the fact that", "because"],
        ["in the event that", "if"],
        ["for the purpose of", "for"],
        ["with regard to", "about"],
        ["prior to", "before"],
        ["a large number of", "many"],
        ["is able to", "can"]
      ],
      medium: [
        ["however,", "but"],
        ["therefore,", "so"],
        ["additionally,", "also,"],
        ["furthermore,", "also,"]
      ],
      light: []
    },

    wordMap: {
      utilize: "use",
      facilitate: "help",
      consequently: "so",
      approximately: "about",
      demonstrate: "show",
      numerous: "many",
      regarding: "about",
      difficult: "hard",
      assist: "help",
      substantial: "large",
      implement: "apply",
      purchase: "buy",
      require: "need"
    },

    fillers: {
      aggressive: /\b(basically|actually|literally|just|really|very|simply|clearly)\b/gi,
      medium: /\b(basically|actually|literally)\b/gi,
      light: /\b(literally)\b/gi
    },

    maxWordsForLevel(level) {
      if (level === LEVELS.AGGRESSIVE) {
        return 15;
      }
      if (level === LEVELS.MEDIUM) {
        return 20;
      }
      return 28;
    },

    applyPhraseMap(text, level) {
      let out = text;
      const phrasePacks = [];
      if (level === LEVELS.AGGRESSIVE) {
        phrasePacks.push(this.phraseMaps.aggressive, this.phraseMaps.medium);
      } else if (level === LEVELS.MEDIUM) {
        phrasePacks.push(this.phraseMaps.medium);
      }
      phrasePacks.forEach((pairs) => {
        pairs.forEach(([from, to]) => {
          const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          out = out.replace(re, to);
        });
      });
      Object.entries(this.wordMap).forEach(([complex, simple]) => {
        const re = new RegExp(`\\b${complex}\\b`, "gi");
        out = out.replace(re, (m) =>
          m[0] === m[0].toUpperCase() ? simple.charAt(0).toUpperCase() + simple.slice(1) : simple
        );
      });
      return out;
    },

    stripFillers(text, level) {
      const rx = this.fillers[level] || this.fillers.light;
      return text.replace(rx, "").replace(/\s{2,}/g, " ");
    },

    splitLongSentences(text, maxWords) {
      const sentences = AnalyzerAgent.splitIntoSentences(text);
      const pieces = [];
      const breakHeavy = (segment) => {
        const wc = AnalyzerAgent.wordCount(segment);
        if (wc <= maxWords) {
          return segment;
        }
        const bySemi = segment.split(/;\s+/);
        if (bySemi.length > 1) {
          return bySemi.map((s) => s.trim()).join(". ") + (segment.includes(".") ? "" : ".");
        }
        const byComma = segment.split(/,\s+/);
        if (byComma.length > 2) {
          const chunkSize = Math.ceil(byComma.length / 2);
          const first = byComma.slice(0, chunkSize).join(", ");
          const rest = byComma.slice(chunkSize).join(", ");
          return `${first.trim()}, and ${rest.trim()}`.replace(/^, and /, "");
        }
        const mid = Math.floor(segment.length / 2);
        const sp = segment.indexOf(" ", mid);
        if (sp > 0) {
          return `${segment.slice(0, sp).trim()}. ${segment.slice(sp + 1).trim()}`;
        }
        return segment;
      };
      sentences.forEach((s) => pieces.push(breakHeavy(s)));
      return { text: pieces.join(" ") };
    },

    simplifyTextHeuristic(text, level) {
      if (!text || !text.trim()) {
        return { text: "" };
      }
      const maxWords = this.maxWordsForLevel(level);
      let working = this.stripFillers(text, level);
      working = this.applyPhraseMap(working, level);
      working = this.splitLongSentences(working, maxWords).text;
      return { text: working.replace(/\s{2,}/g, " ").trim() };
    },

    processTextNodes(level) {
      return this.processTextNodesInRoot(document.body, level);
    },

    /**
     * Heuristic simplification scoped to a subtree (preserves element structure; touches text nodes only).
     */
    processTextNodesInRoot(rootEl, level) {
      if (!rootEl) {
        return { sentenceSplits: 0, heuristicReplacements: 0 };
      }
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) {
            return NodeFilter.FILTER_REJECT;
          }
          const parent = node.parentElement;
          if (!parent) {
            return NodeFilter.FILTER_REJECT;
          }
          const blocked = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "KBD", "SAMP"];
          if (blocked.includes(parent.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (parent.closest(`#${PANEL_ID}`) || parent.closest(`#${WIDGET_HOST_ID}`)) {
            return NodeFilter.FILTER_REJECT;
          }
          const block = parent.closest("p, li, td, th");
          if (!block) {
            return NodeFilter.FILTER_REJECT;
          }
          if (ContentExtractorAgent.isNoiseElement(block)) {
            return NodeFilter.FILTER_REJECT;
          }
          const blockText = normalizeTextContent(block.textContent || "");
          if (blockText.length < 50) {
            return NodeFilter.FILTER_REJECT;
          }
          if (!ContentExtractorAgent.paragraphNeedsLLM(blockText) && blockText.length < 120) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
        if (nodes.length >= HEURISTIC_TEXT_NODE_CAP) {
          break;
        }
      }

      let totalReplacements = 0;
      nodes.forEach((textNode) => {
        const original = textNode.nodeValue;
        if (!original || original.length < 12) {
          return;
        }
        const result = this.simplifyTextHeuristic(original, level);
        if (result.text !== original) {
          textNode.nodeValue = result.text;
          totalReplacements += 1;
        }
      });

      return { sentenceSplits: 0, heuristicReplacements: totalReplacements };
    }
  };

  /** True if paragraph has no nested elements (except BR) — safe for whole-block LLM replace. */
  function isPlainTextBlock(el) {
    if (!el?.childNodes) {
      return false;
    }
    for (let i = 0; i < el.childNodes.length; i += 1) {
      const n = el.childNodes[i];
      if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== "BR") {
        return false;
      }
    }
    return true;
  }

  /**
   * Focus Mode Layer: elevate main reading column; soften chrome without removing DOM.
   */
  const LayoutAgent = {
    dimSelectors: [
      "nav",
      "footer",
      "aside",
      "header",
      "[role='navigation']",
      "[role='banner']",
      "[role='contentinfo']",
      "[role='complementary']",
      ".modal-backdrop",
      ".popup-overlay",
      ".overlay-backdrop",
      '[class*="cookie-banner"]',
      '[id*="cookie-banner"]'
    ],

    shouldDimChrome(el, mainEl) {
      if (!el?.closest) {
        return false;
      }
      if (el.closest(`#${PANEL_ID}`) || el.closest(`#${WIDGET_HOST_ID}`)) {
        return false;
      }
      if (mainEl) {
        if (mainEl.contains(el)) {
          return false;
        }
        if (el.contains(mainEl)) {
          return false;
        }
      }
      return true;
    },

    removeIntrusivePopups() {
      // Optmized query isolating likely popup containers (not all elements)
      const popups = document.querySelectorAll('div, iframe, aside, section, form, [role="dialog"], [role="alertdialog"]');
      let killed = 0;
      popups.forEach((el) => {
        if (!el || !(el instanceof HTMLElement)) return;
        if (el.closest(`#${PANEL_ID}`) || el.closest(`#${WIDGET_HOST_ID}`)) return;

        const style = window.getComputedStyle(el);
        if ((style.position === 'fixed' || style.position === 'sticky') && parseInt(style.zIndex, 10) > 90) {
          // Safety: Don't kill the sole main nav element 
          if (el.tagName === 'NAV' && document.querySelectorAll('nav').length <= 1) return;
          el.style.display = 'none';
          killed++;
        }
      });
      return killed;
    },

    resolveFocusMain() {
      const candidates = [
        document.querySelector("main"),
        document.querySelector("article"),
        document.querySelector("[role='main']"),
        document.querySelector("#mw-content-text"),
        document.querySelector("#content article"),
        document.querySelector(".post-content")
      ].filter(Boolean);
      const ok = candidates.find(
        (n) => n && !n.closest(`#${PANEL_ID}`) && !n.closest(`#${WIDGET_HOST_ID}`)
      );
      return ok || null;
    },

    applyFocusModeLayer(mode) {
      const mainEl = this.resolveFocusMain();
      let dimCount = 0;

      document.documentElement.classList.add("neuroadapt-focus-mode-active");
      document.body.classList.add("neuroadapt-body-root", "neuroadapt-layout-active");
      document.body.classList.remove("neuroadapt-reading", "neuroadapt-quick-scan");
      if (mode === MODES.READING) {
        document.body.classList.add("neuroadapt-reading");
      } else if (mode === MODES.QUICK_SCAN) {
        document.body.classList.add("neuroadapt-quick-scan");
      }

      if (mainEl) {
        mainEl.classList.add("neuroadapt-focus-main", "neuroadapt-readable-sub");
      }

      this.dimSelectors.forEach((sel) => {
        let nodes;
        try {
          nodes = document.querySelectorAll(sel);
        } catch {
          return;
        }
        nodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) {
            return;
          }
          if (!this.shouldDimChrome(node, mainEl)) {
            return;
          }
          node.classList.add("neuroadapt-focus-chrome");
          dimCount += 1;
        });
      });

      const popupsKilled = this.removeIntrusivePopups();

      return { dimCount, popupsKilled, mainEl, contentRootTag: mainEl ? mainEl.tagName : "none" };
    },

    async applyReadabilityInMain(mainEl) {
      if (!mainEl) {
        return;
      }
      mainEl.classList.add("neuroadapt-readable-main");
      await yieldToUI();
    }
  };

  function getAiSettings() {
    return new Promise((resolve) => {
      if (!extensionRuntimeOk()) {
        resolve({ hasConfiguredKey: false });
        return;
      }
      chrome.runtime.sendMessage({ type: "GET_AI_SETTINGS" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ hasConfiguredKey: false });
          return;
        }
        resolve(response?.settings || { hasConfiguredKey: false });
      });
    });
  }

  function sendMessageTimed(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!extensionRuntimeOk()) {
        resolve({ ok: false, error: "Extension unavailable" });
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve({ ok: false, error: "Request timed out", timedOut: true });
      }, timeoutMs);

      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (settled) {
          return;
        }
        clearTimeout(timer);
        settled = true;
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "No response" });
      });
    });
  }

  async function simplifyTextAI(text, level) {
    const res = await sendMessageTimed("SIMPLIFY_TEXT", { text, level }, AI_SECTION_TIMEOUT_MS);
    if (res?.ok && typeof res.text === "string" && res.text.trim().length > 0) {
      return { text: res.text.trim(), meta: { source: "llm" } };
    }
    const h = SimplificationAgent.simplifyTextHeuristic(text, level);
    return {
      text: h.text,
      meta: { source: "local", error: res?.error }
    };
  }

  async function simplifyBlockElement(el, level) {
    let t = normalizeTextContent(el.textContent || "");
    if (t.length > AI_MAX_CHARS) {
      t = t.slice(0, AI_MAX_CHARS);
    }
    if (isPlainTextBlock(el)) {
      const out = await simplifyTextAI(t, level);
      el.textContent = out.text || t;
      return {
        usedLlm: out.meta?.source === "llm",
        err: out.meta?.source !== "llm" ? out.meta?.error : undefined
      };
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 24) {
          return NodeFilter.FILTER_REJECT;
        }
        const p = node.parentElement;
        if (!p || ["SCRIPT", "STYLE", "CODE", "PRE", "KBD", "SAMP"].includes(p.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let nEdited = 0;
    while (walker.nextNode()) {
      const tn = walker.currentNode;
      const orig = tn.nodeValue;
      if (AnalyzerAgent.wordCount(orig.replace(/\s+/g, " ").trim()) <= LONG_WORD_THRESHOLD) {
        continue;
      }
      const h = SimplificationAgent.simplifyTextHeuristic(orig, level);
      if (h.text !== orig) {
        tn.nodeValue = h.text;
        nEdited += 1;
      }
    }
    return { usedLlm: false, err: undefined };
  }

  async function processMainContentWithLLM(level, onStatus, mainEl) {
    await yieldToUI();
    const scopeRoot = mainEl || ContentExtractorAgent.getMainRoot();
    const settings = await getAiSettings();
    const canLLM = Boolean(settings.hasConfiguredKey && extensionRuntimeOk());

    if (!canLLM) {
      onStatus("⚠️ No API key — gentle local edits in main content.");
      await yieldToUI();
      onStatus("");
      const local = SimplificationAgent.processTextNodesInRoot(scopeRoot, level);
      return {
        sentenceSplits: local.sentenceSplits,
        heuristicReplacements: local.heuristicReplacements,
        aiCalls: 0,
        aiErrors: 0,
        usedAi: false
      };
    }

    const els = ContentExtractorAgent.getParagraphsToSimplify(MAX_SIMPLIFY_BLOCKS, scopeRoot);
    if (!els.length) {
      onStatus("");
      const local = SimplificationAgent.processTextNodesInRoot(scopeRoot, level);
      return {
        sentenceSplits: 0,
        heuristicReplacements: local.heuristicReplacements,
        aiCalls: 0,
        aiErrors: 0,
        usedAi: false
      };
    }

    let aiCalls = 0;
    let aiErrors = 0;
    let usedAi = false;
    let totalReplacements = 0;

    for (let i = 0; i < els.length; i += 1) {
      onStatus(`🧠 Refining dense text (${i + 1}/${els.length})…`);
      await yieldToUI();
      const el = els[i];
      try {
        const { usedLlm, err } = await simplifyBlockElement(el, level);
        if (usedLlm) {
          usedAi = true;
          aiCalls += 1;
        } else if (err) {
          aiErrors += 1;
        }
        totalReplacements += 1;
      } catch {
        aiErrors += 1;
      }
      await new Promise((r) => setTimeout(r, AI_REQUEST_GAP_MS));
    }

    onStatus("");
    return {
      sentenceSplits: 0,
      heuristicReplacements: totalReplacements,
      aiCalls,
      aiErrors,
      usedAi
    };
  }

  async function applyTransformationBundle() {
    await yieldToUI();
    if (state.transformed) {
      return (
        state.lastTransformResult || {
          removedDistractions: 0,
          layoutApplied: true,
          readabilityApplied: true,
          sentenceSplits: 0,
          heuristicReplacements: 0,
          aiCalls: 0,
          aiErrors: 0,
          usedAi: false,
          simplificationLevel: state.simplificationLevel,
          mode: state.currentMode
        }
      );
    }

    const mode = state.currentMode;
    let level = LearningAgent.getSimplificationLevel();
    if (mode === MODES.QUICK_SCAN) {
      level = LEVELS.LIGHT;
    } else if (mode === MODES.READING && level === LEVELS.LIGHT) {
      level = LEVELS.MEDIUM;
    }

    const { dimCount, mainEl } = LayoutAgent.applyFocusModeLayer(mode);
    await LayoutAgent.applyReadabilityInMain(mainEl);

    const textStats = await processMainContentWithLLM(level, setAiStatus, mainEl);

    state.transformed = true;
    const result = {
      removedDistractions: dimCount,
      layoutApplied: true,
      readabilityApplied: true,
      sentenceSplits: textStats.sentenceSplits,
      heuristicReplacements: textStats.heuristicReplacements,
      aiCalls: textStats.aiCalls,
      aiErrors: textStats.aiErrors,
      usedAi: textStats.usedAi,
      simplificationLevel: level,
      mode
    };
    state.lastTransformResult = result;
    return result;
  }

  const ReadingLens = {
    raf: 0,
    onScroll: null,
    onPointer: null,
    tagged: [],
    /** @type {HTMLElement | null} */
    pointerBlock: null,
    pointerClearId: 0,
    lastPointerSample: 0,

    isEnabled() {
      return document.documentElement.classList.contains("neuroadapt-lens-root");
    },

    setEnabled(on) {
      if (on) {
        document.documentElement.classList.add("neuroadapt-lens-root");
        this.bind();
        this.scheduleUpdate();
      } else {
        document.documentElement.classList.remove("neuroadapt-lens-root");
        this.unbind();
        this.clearTags();
        this.pointerBlock = null;
      }
    },

    bind() {
      this.onScroll = () => this.scheduleUpdate();
      this.onPointer = (e) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        if (now - this.lastPointerSample < 50) {
          return;
        }
        this.lastPointerSample = now;
        const t = e.target;
        if (!t?.closest) {
          return;
        }
        if (t.closest(`#${WIDGET_HOST_ID}`)) {
          return;
        }
        const block = t.closest("p, li");
        if (block instanceof HTMLElement && !ContentExtractorAgent.isNoiseElement(block)) {
          this.pointerBlock = block;
          clearTimeout(this.pointerClearId);
          this.pointerClearId = window.setTimeout(() => {
            this.pointerBlock = null;
          }, 2200);
        }
        this.scheduleUpdate();
      };
      window.addEventListener("scroll", this.onScroll, { passive: true });
      window.addEventListener("resize", this.onScroll, { passive: true });
      document.addEventListener("pointermove", this.onPointer, { passive: true });
    },

    unbind() {
      if (this.onScroll) {
        window.removeEventListener("scroll", this.onScroll);
        window.removeEventListener("resize", this.onScroll);
        this.onScroll = null;
      }
      if (this.onPointer) {
        document.removeEventListener("pointermove", this.onPointer);
        this.onPointer = null;
      }
      clearTimeout(this.pointerClearId);
      this.pointerClearId = 0;
      if (this.raf) {
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    },

    clearTags() {
      for (const el of this.tagged) {
        el.classList.remove("neuroadapt-lens-dim", "neuroadapt-lens-focus");
      }
      this.tagged = [];
    },

    scheduleUpdate() {
      if (!this.isEnabled()) {
        return;
      }
      if (this.raf) {
        return;
      }
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.update();
      });
    },

    update() {
      if (!this.isEnabled()) {
        return;
      }
      this.clearTags();
      const root = ContentExtractorAgent.getMainRoot();
      const vh = window.innerHeight;
      const midY = vh * 0.42;
      const all = root.querySelectorAll("p, li");
      const limit = Math.min(all.length, 100);

      let preferred = this.pointerBlock;
      if (preferred) {
        const pr = preferred.getBoundingClientRect();
        if (
          pr.bottom < -8 ||
          pr.top > vh + 8 ||
          ContentExtractorAgent.isNoiseElement(preferred)
        ) {
          preferred = null;
        }
      }

      /** @type {{ el: HTMLElement, score: number }[]} */
      const scored = [];

      for (let i = 0; i < limit; i += 1) {
        const p = all[i];
        if (!(p instanceof HTMLElement)) {
          continue;
        }
        if (ContentExtractorAgent.isNoiseElement(p)) {
          continue;
        }
        const r = p.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) {
          continue;
        }
        const vis = Math.min(vh, r.bottom) - Math.max(0, r.top);
        if (vis <= 0) {
          continue;
        }
        p.classList.add("neuroadapt-lens-dim");
        this.tagged.push(p);
        const centerDist = Math.abs((r.top + r.bottom) / 2 - midY);
        const score = vis - centerDist * 0.14;
        scored.push({ el: p, score });
      }

      let best = null;
      let bestScore = -1e9;
      if (preferred && this.tagged.includes(preferred)) {
        best = preferred;
      } else {
        for (const { el, score } of scored) {
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
      }

      if (best) {
        best.classList.remove("neuroadapt-lens-dim");
        best.classList.add("neuroadapt-lens-focus");
      }
    },

    teardown() {
      this.setEnabled(false);
    }
  };

  function runPipeline() {
    const features = AnalyzerAgent.analyzePage();
    const scored = ScoringAgent.score(features);
    return {
      score: scored.score,
      category: scored.category,
      narrative: ExplanationAgent.buildNarrative(features),
      reasons: ExplanationAgent.buildBulletReasons(features),
      features
    };
  }

  function stressLabel(category) {
    if (category === "High") {
      return "🔴 High Stress";
    }
    if (category === "Medium") {
      return "🟡 Medium Stress";
    }
    return "🟢 Low Stress";
  }

  function stressEmoji(category) {
    if (category === "High") {
      return "🔴";
    }
    if (category === "Medium") {
      return "🟡";
    }
    return "🟢";
  }

  function improvementPct(beforeScore, afterScore) {
    if (beforeScore <= 0) {
      return 0;
    }
    return Number(Math.max(0, ((beforeScore - afterScore) / beforeScore) * 100).toFixed(1));
  }

  function setAiStatus(message, isError) {
    const el = document.getElementById("neuroadapt-ai-status");
    if (!el) {
      return;
    }
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      el.classList.remove("neuroadapt-ai-status--error");
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle("neuroadapt-ai-status--error", Boolean(isError));
  }

  function categoryBandText(category) {
    if (category === "High") {
      return "High band: 60+";
    }
    if (category === "Medium") {
      return "Medium band: 30–60";
    }
    return "Low band: 0–30";
  }

  function updateScoreUI(metrics) {
    const el = state.panelElements;
    if (!el) {
      return;
    }
    el.stress.textContent = stressLabel(metrics.category);
    el.score.textContent = `Cognitive Load: ${metrics.category}`;
    el.narrative.textContent = metrics.narrative;
    el.explanation.innerHTML = "";
    metrics.reasons.forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      el.explanation.appendChild(li);
    });

    const hint = el.smartHint;
    if (hint) {
      if (metrics.score >= HIGH_LOAD_THRESHOLD) {
        hint.hidden = false;
        hint.textContent =
          "This page looks heavy. Want help simplifying?";
      } else {
        hint.hidden = true;
        hint.textContent = "";
      }
    }

    const note = el.focusNote;
    if (metrics.score >= HIGH_LOAD_THRESHOLD) {
      note.hidden = false;
      note.textContent =
        "High cognitive load detected. Try Focus Mode or Make This Easier.";
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  }

  function updateBeforeAfterUI(metrics, options = {}) {
    const el = state.panelElements;
    if (!el) {
      return;
    }
    el.compare.innerHTML = "";
    el.changes.innerHTML = "";

    if (options.showComparison && options.beforeSnapshot) {
      const before = options.beforeSnapshot;
      const after = metrics;
      const imp = improvementPct(before.score, after.score);
      el.compare.innerHTML = `
        <strong>Before vs After</strong><br>
        Before: ${before.score} ${stressEmoji(before.category)}<br>
        After: ${after.score} ${stressEmoji(after.category)}<br>
        Improvement: ${imp}%
      `;
      if (options.transform) {
        const t = options.transform;
        const aiLine = t.usedAi
          ? `✔ Text: LLM (${t.aiCalls} blocks${t.aiErrors ? `, ${t.aiErrors} fallbacks` : ""})`
          : `✔ Text: local heuristic · ${t.simplificationLevel}`;
        el.changes.innerHTML = `
          <strong>Reduce Distractions — applied</strong>
          <div class="neuroadapt-change-line">✔ ${t.removedDistractions} chrome regions softened (dimmed, not removed)</div>
          <div class="neuroadapt-change-line">${aiLine}</div>
          <div class="neuroadapt-change-line">✔ Main reading column (${String(t.mode).replace("_", " ")} profile)</div>
          <div class="neuroadapt-change-line">✔ Easier type in main content (≥18px, line-height ≥1.65)</div>
        `;
      }
    }
  }

  function refreshMemoryLine() {
    const el = state.panelElements;
    if (!el?.memory) {
      return;
    }
    const clicks = LearningAgent.getFixClicks();
    const mode = LearningAgent.getPreferredMode();
    const level = LearningAgent.getSimplificationLevel();
    const auto = LearningAgent.getAutoHighLoad();
    const habit = LearningAgent.shouldAutoApplyFromHabit();
    el.memory.textContent = `Memory: fixes=${clicks}; mode=${mode}; simplify=${level}; auto high-load=${auto ? "on" : "off"}; frequent use=${habit ? "yes" : "no"}.`;
    if (el.engagement) {
      const tier = clicks >= 10 ? "Gold reader" : clicks >= 3 ? "Active" : "Starter";
      el.engagement.textContent = `🌟 ${tier} · ${clicks} fix${clicks === 1 ? "" : "es"} this browser`;
    }
  }

  function loadState() {
    const x = parseFloat(localStorage.getItem(UI_LS.x) || "");
    const y = parseFloat(localStorage.getItem(UI_LS.y) || "");
    return {
      isOpen: localStorage.getItem(UI_LS.isOpen) === "1",
      collapsed: localStorage.getItem(UI_LS.collapsed) === "1",
      side: localStorage.getItem(UI_LS.side) === "left" ? "left" : "right",
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      theme: localStorage.getItem(UI_LS.theme) || "dark",
      focusStrip: localStorage.getItem(UI_LS.focusStrip) === "1",
      comfortSpacing: localStorage.getItem(UI_LS.comfortSpacing) === "1",
      reduceMotion: localStorage.getItem(UI_LS.reduceMotion) === "1"
    };
  }

  function saveState(patch) {
    if (patch.isOpen !== undefined) {
      localStorage.setItem(UI_LS.isOpen, patch.isOpen ? "1" : "0");
    }
    if (patch.collapsed !== undefined) {
      localStorage.setItem(UI_LS.collapsed, patch.collapsed ? "1" : "0");
    }
    if (patch.side) {
      localStorage.setItem(UI_LS.side, patch.side);
    }
    if (patch.x === null) {
      localStorage.removeItem(UI_LS.x);
    } else if (patch.x !== undefined && patch.x !== null) {
      localStorage.setItem(UI_LS.x, String(Math.round(patch.x)));
    }
    if (patch.y === null) {
      localStorage.removeItem(UI_LS.y);
    } else if (patch.y !== undefined && patch.y !== null) {
      localStorage.setItem(UI_LS.y, String(Math.round(patch.y)));
    }
    if (patch.theme) {
      localStorage.setItem(UI_LS.theme, patch.theme);
    }
    if (patch.focusStrip !== undefined) {
      localStorage.setItem(UI_LS.focusStrip, patch.focusStrip ? "1" : "0");
    }
    if (patch.comfortSpacing !== undefined) {
      localStorage.setItem(UI_LS.comfortSpacing, patch.comfortSpacing ? "1" : "0");
    }
    if (patch.reduceMotion !== undefined) {
      localStorage.setItem(UI_LS.reduceMotion, patch.reduceMotion ? "1" : "0");
    }
  }

  function applyComfortSpacing(on) {
    if (on) {
      document.body.classList.add("neuroadapt-comfort-spacing");
    } else {
      document.body.classList.remove("neuroadapt-comfort-spacing");
    }
  }

  function clampPanelPosition(rootEl) {
    if (!rootEl) {
      return;
    }
    const margin = 10;
    const w = rootEl.offsetWidth || 280;
    const h = rootEl.offsetHeight || 120;
    let left = parseFloat(rootEl.style.left) || 0;
    let top = parseFloat(rootEl.style.top) || 0;
    if (!Number.isFinite(left)) {
      left = margin;
    }
    if (!Number.isFinite(top)) {
      top = margin;
    }
    left = Math.min(Math.max(margin, left), window.innerWidth - w - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - h - margin);
    rootEl.style.left = `${left}px`;
    rootEl.style.top = `${top}px`;
    rootEl.style.right = "auto";
    saveState({ x: left, y: top });
  }

  function applyDefaultAnchor(rootEl, side) {
    const margin = 16;
    const w = rootEl.offsetWidth || 300;
    const h = rootEl.offsetHeight || 120;
    if (side === "left") {
      rootEl.style.left = `${margin}px`;
      rootEl.style.top = `${Math.max(margin, window.innerHeight - h - margin)}px`;
    } else {
      rootEl.style.left = `${Math.max(margin, window.innerWidth - w - margin)}px`;
      rootEl.style.top = `${Math.max(margin, window.innerHeight - h - margin)}px`;
    }
    rootEl.style.right = "auto";
    clampPanelPosition(rootEl);
  }

  function getTopVisibleParagraphs(max) {
    const root = ContentExtractorAgent.getMainRoot();
    const vh = window.innerHeight;
    const all = root.querySelectorAll("p");
    const cap = Math.min(all.length, 72);
    const scored = [];
    for (let i = 0; i < cap; i += 1) {
      const p = all[i];
      if (ContentExtractorAgent.isNoiseElement(p)) {
        continue;
      }
      const r = p.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh) {
        continue;
      }
      const visH = Math.min(vh, r.bottom) - Math.max(0, r.top);
      if (visH <= 0) {
        continue;
      }
      const score = visH * (visH / Math.max(r.height, 1));
      scored.push({ p, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, max).map((x) => x.p);
  }

  function extractVisibleContent() {
    const selObj = window.getSelection();
    const sel = selObj?.toString()?.trim();
    if (sel && sel.length >= 10 && selObj.rangeCount > 0) {
      return { text: sel.slice(0, SECTION_CHAR_CAP), source: "selection", range: selObj.getRangeAt(0) };
    }
    const paras = getTopVisibleParagraphs(3);
    if (paras.length) {
      const joined = paras.map((p) => normalizeTextContent(p.textContent || "")).join("\n\n");
      if (joined.length >= 20) {
        return { text: joined.slice(0, SECTION_CHAR_CAP), source: "visible", nodes: paras };
      }
    }
    const root = ContentExtractorAgent.getMainRoot();
    const h = root.querySelector("h1") || root.querySelector("h2");
    const firstPs = [...root.querySelectorAll("p")]
      .filter((p) => !ContentExtractorAgent.isNoiseElement(p))
      .slice(0, 3);
    let t = "";
    if (h) {
      t += `${normalizeTextContent(h.textContent || "")}\n\n`;
    }
    t += firstPs.map((p) => normalizeTextContent(p.textContent || "")).join("\n\n");
    return { text: t.slice(0, SECTION_CHAR_CAP).trim(), source: "fallback", nodes: firstPs };
  }

  function fallbackSimplifySection(text, level) {
    const h = SimplificationAgent.simplifyTextHeuristic(text, level);
    const sentences = AnalyzerAgent.splitIntoSentences(h.text).slice(0, 5);
    if (!sentences.length) {
      return "• Could not simplify this section.";
    }
    return sentences
      .map((s) => `• ${s.length > 200 ? `${s.slice(0, 197)}…` : s}`)
      .join("\n");
  }

  async function actionVisibleSection(actionType) {
    const gen = simplifyGeneration + 1;
    simplifyGeneration = gen;
    setMachineState(Machine.SIMPLIFYING);
    let msg = "Processing…";
    if (actionType === "summarize") msg = "Summarizing page…";
    if (actionType === "key_points") msg = "Extracting key points…";
    if (actionType === "shorter") msg = "Making text shorter…";
    if (actionType === "simplify") msg = "Simplifying section…";
    if (actionType === "quiz") msg = "Generating quick quiz…";
    setAiStatus("🧠 Simplifying…");

    const outEl = document.getElementById("neuroadapt-section-out");
    if (outEl) {
      outEl.textContent = "";
    }

    await yieldToUI();
    const level = LearningAgent.getSimplificationLevel();
    setAiStatus(msg);
    const { text, source, range, nodes } = extractVisibleContent();
    if (!text || text.length < 12) {
      if (gen !== simplifyGeneration) return;
      setMachineState(Machine.ERROR);
      setAiStatus("Could not process section — no text found.", true);
      return;
    }

    try {
      const settings = await getAiSettings();
      let body = "";
      let usedFallback = false;
      const profileInfo = { neuroProfile: LearningAgent.getNeuroProfile() };

      if (settings.hasConfiguredKey) {
        let res;
        if (actionType === "summarize") {
          res = await sendMessageTimed("SUMMARIZE_PAGE", { text, ...profileInfo }, 8500);
          if (gen !== simplifyGeneration) return;
          if (res.ok && res.summary) {
            body = res.summary;
            if (res.fallback) usedFallback = true;
          } else {
            body = fallbackSimplifySection(text, level);
            usedFallback = true;
          }
        } else if (actionType === "quiz") {
            res = await sendMessageTimed("QUIZ_PAGE", { text, ...profileInfo }, 12000);
            if (gen !== simplifyGeneration) return;
            if (res.ok && res.text) body = res.text;
            else { body = fallbackSimplifySection(text, level); usedFallback = true; }
        } else if (actionType === "key_points") {
          res = await sendMessageTimed("KEY_POINTS_TEXT", { text, ...profileInfo }, 8500);
          if (gen !== simplifyGeneration) return;
          if (res.ok && res.text) body = res.text;
          else { body = fallbackSimplifySection(text, level); usedFallback = true; }
        } else if (actionType === "shorter") {
          res = await sendMessageTimed("SIMPLIFY_TEXT", { text, level: "aggressive", ...profileInfo }, 8500);
          if (gen !== simplifyGeneration) return;
          if (res.ok && res.text) body = res.text;
          else { body = fallbackSimplifySection(text, level); usedFallback = true; }
        } else {
          const ai = await sendMessageTimed("SIMPLIFY_TEXT", { text, level, ...profileInfo }, 8500);
          if (gen !== simplifyGeneration) return;
          if (ai.ok && ai.text) body = ai.text;
          else { body = fallbackSimplifySection(text, level); usedFallback = true; }
        }
      } else {
        body = fallbackSimplifySection(text, level);
        usedFallback = true;
      }

      if (gen !== simplifyGeneration) return;

      if (actionType === "simplify" && !usedFallback) {
          if (source === "selection" && range) {
              const span = document.createElement("span");
              span.className = "neuroadapt-inline-morph";
              span.style.color = "var(--neuroadapt-accent)";
              span.style.backgroundColor = "rgba(100, 200, 255, 0.15)";
              span.style.padding = "2px 4px";
              span.style.borderRadius = "4px";
              span.style.transition = "all 0.4s ease";
              span.innerHTML = body.replace(/\n/g, '<br/>');
              span.dataset.orig = text;
              range.deleteContents();
              range.insertNode(span);
          } else if (nodes && nodes.length > 0) {
              const formatted = body.replace(/\n/g, '<br/>');
              nodes[0].innerHTML = `<span class="neuroadapt-inline-morph" style="color: var(--neuroadapt-accent); background: rgba(100, 200, 255, 0.15); padding: 2px 4px; border-radius: 4px; transition: all 0.4s ease;">${formatted}</span>`;
              for (let i = 1; i < nodes.length; i++) {
                  nodes[i].style.display = "none";
              }
          }
      }

      setAiStatus(usedFallback ? "⚠️ Showing quick version (AI unavailable)" : "✨ Done");
      setMachineState(Machine.OPEN);
      if (outEl) outEl.textContent = body;
    } catch (e) {
      if (gen !== simplifyGeneration) return;
      setMachineState(Machine.ERROR);
      setAiStatus("Could not process this text.", true);
      if (outEl) outEl.textContent = fallbackSimplifySection(text, level);
    }
  }

  function handleDragStart(e) {
    if (e.button !== 0) {
      return;
    }
    const t = e.target;
    const fromHandle = t?.closest?.(".neuroadapt-drag-handle");
    const fromFab = t?.closest?.("#neuroadapt-fab");
    if (!fromHandle && !fromFab) {
      return;
    }
    const root = document.getElementById(WIDGET_HOST_ID);
    if (!root) {
      return;
    }
    const ui = loadState();
    if (!fromFab && ui.collapsed) {
      return;
    }
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    root.classList.add("neuroadapt-root--dragging");
    uiDrag = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top
    };
    document.addEventListener("mousemove", handleDragMove, true);
    document.addEventListener("mouseup", handleDragEnd, true);
  }

  function handleDragMove(e) {
    if (!uiDrag) {
      return;
    }
    const root = document.getElementById(WIDGET_HOST_ID);
    if (!root) {
      return;
    }
    root.style.left = `${uiDrag.origLeft + (e.clientX - uiDrag.startX)}px`;
    root.style.top = `${uiDrag.origTop + (e.clientY - uiDrag.startY)}px`;
    root.style.right = "auto";
  }

  function handleDragEnd() {
    if (!uiDrag) {
      return;
    }
    uiDrag = null;
    document.removeEventListener("mousemove", handleDragMove, true);
    document.removeEventListener("mouseup", handleDragEnd, true);
    const root = document.getElementById(WIDGET_HOST_ID);
    if (root) {
      root.classList.remove("neuroadapt-root--dragging");
      clampPanelPosition(root);
    }
  }

  function handleOutsideClick() {
    outsideDown = (e) => {
      const root = document.getElementById(WIDGET_HOST_ID);
      if (!root || root.contains(e.target)) {
        return;
      }
      closeWidget();
    };
    document.addEventListener("pointerdown", outsideDown, true);
  }

  function handleEscClose() {
    escKey = (e) => {
      if (e.key === "Escape") {
        closeWidget();
      }
    };
    document.addEventListener("keydown", escKey, true);
  }

  function unwireGlobalHandlers() {
    if (outsideDown) {
      document.removeEventListener("pointerdown", outsideDown, true);
      outsideDown = null;
    }
    if (escKey) {
      document.removeEventListener("keydown", escKey, true);
      escKey = null;
    }
    handleDragEnd();
  }

  function applyUiStateToDom() {
    const ui = loadState();
    const root = document.getElementById(WIDGET_HOST_ID);
    const panel = document.getElementById(PANEL_ID);
    const fab = document.getElementById("neuroadapt-fab");
    if (!root || !panel || !fab) {
      return;
    }

    mountWidgetHostToDocument(root);

    root.dataset.theme = ui.theme;
    root.dataset.reduceMotion = ui.reduceMotion ? "1" : "0";
    root.classList.toggle("neuroadapt-root--collapsed", ui.collapsed);
    root.classList.toggle("neuroadapt-root--side-left", ui.side === "left");
    root.classList.toggle("neuroadapt-root--side-right", ui.side === "right");

    const themeSel = document.getElementById("neuroadapt-theme");
    if (themeSel) {
      themeSel.value = ui.theme;
    }
    const modeSel = document.getElementById("neuroadapt-mode");
    if (modeSel) {
      modeSel.value = LearningAgent.getPreferredMode();
    }
    const levelSel = document.getElementById("neuroadapt-level");
    if (levelSel) {
      levelSel.value = LearningAgent.getSimplificationLevel();
    }
    const autoHigh = document.getElementById("neuroadapt-auto-high");
    if (autoHigh) {
      autoHigh.checked = LearningAgent.getAutoHighLoad();
    }
    const lensCb = document.getElementById("neuroadapt-lens-toggle");
    if (lensCb) {
      lensCb.checked = ui.focusStrip;
    }
    const spaceCb = document.getElementById("neuroadapt-spacing-toggle");
    if (spaceCb) {
      spaceCb.checked = ui.comfortSpacing;
    }
    const motionCb = document.getElementById("neuroadapt-motion-toggle");
    if (motionCb) {
      motionCb.checked = ui.reduceMotion;
    }

    const profileSel = document.getElementById("neuroadapt-profile");
    if (profileSel) {
      profileSel.value = LearningAgent.getNeuroProfile();
    }
    const bionicCb = document.getElementById("neuroadapt-bionic-toggle");
    if (bionicCb) {
      bionicCb.checked = LearningAgent.getBionicAnchors();
    }

    if (ui.x !== null && ui.y !== null) {
      root.style.left = `${ui.x}px`;
      root.style.top = `${ui.y}px`;
      root.style.right = "auto";
    } else {
      applyDefaultAnchor(root, ui.side);
    }

    panel.hidden = ui.collapsed;
    fab.hidden = !ui.collapsed;

    const collapseBtn = document.getElementById("neuroadapt-btn-collapse");
    if (collapseBtn) {
      collapseBtn.textContent = ui.collapsed ? "+" : "−";
      collapseBtn.setAttribute("aria-expanded", ui.collapsed ? "false" : "true");
    }

    ReadingLens.setEnabled(ui.focusStrip);
    if (ui.focusStrip) {
      ReadingLens.scheduleUpdate();
    }
    applyComfortSpacing(ui.comfortSpacing);

    setMachineState(ui.collapsed ? Machine.COLLAPSED : Machine.OPEN);

    requestAnimationFrame(() => {
      const r = document.getElementById(WIDGET_HOST_ID);
      if (r) {
        clampPanelPosition(r);
      }
    });
  }

  function toggleCollapse() {
    const ui = loadState();
    saveState({ collapsed: !ui.collapsed });
    applyUiStateToDom();
  }

  function toggleSideAnchor() {
    const ui = loadState();
    saveState({ side: ui.side === "left" ? "right" : "left", x: null, y: null });
    applyUiStateToDom();
  }

  async function onFixClick() {

    const before = state.baselineMetrics || runPipeline();
    state.baselineMetrics = before;

    LearningAgent.incrementFixClicks();
    const autoHighEl = document.getElementById("neuroadapt-auto-high");
    if (autoHighEl) {
      autoHighEl.checked = LearningAgent.getAutoHighLoad();
    }

    const fixBtn = state.panelElements?.fixBtn;
    if (fixBtn) {
      fixBtn.disabled = true;
      fixBtn.textContent = "⏳ Applying…";
    }

    let transform;
    try {
      transform = await applyTransformationBundle();
    } catch (err) {
      console.error(err);
      setAiStatus("❌ Fix failed — page left unchanged where possible.");
      setTimeout(() => setAiStatus(""), 5000);
      if (fixBtn) {
        fixBtn.disabled = false;
        fixBtn.textContent = "✨ Fix this page";
      }
      return;
    }

    state.transformed = true;
    if (fixBtn) {
      fixBtn.disabled = false;
      fixBtn.textContent = "♻️ Update Fixes";
    }

    const after = runPipeline();

    updateScoreUI(after);
    updateBeforeAfterUI(after, {
      showComparison: true,
      beforeSnapshot: before,
      transform
    });
    refreshMemoryLine();
  }

  function bindPanelControls(root) {
    root.addEventListener("mousedown", handleDragStart);

    document.getElementById("neuroadapt-btn-collapse")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse();
    });
    document.getElementById("neuroadapt-btn-side")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSideAnchor();
    });
    document.getElementById("neuroadapt-btn-close")?.addEventListener("click", (e) => {
      e.stopPropagation();
      closeWidget();
    });

    document.getElementById("neuroadapt-fab")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCollapse();
    });

    document.getElementById("neuroadapt-simplify-section")?.addEventListener("click", () => {
      void actionVisibleSection("simplify");
    });
    document.getElementById("neuroadapt-key-points")?.addEventListener("click", () => {
      void actionVisibleSection("key_points");
    });
    document.getElementById("neuroadapt-make-shorter")?.addEventListener("click", () => {
      void actionVisibleSection("shorter");
    });
    document.getElementById("neuroadapt-summarize-page")?.addEventListener("click", () => {
      void actionVisibleSection("summarize");
    });
    document.getElementById("neuroadapt-quiz-page")?.addEventListener("click", () => {
      void actionVisibleSection("quiz");
    });

    document.getElementById("neuroadapt-fix-btn")?.addEventListener("click", () => {
      void onFixClick();
    });

    document.getElementById("neuroadapt-mode")?.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      state.currentMode = v;
      LearningAgent.setPreferredMode(v);
      if (state.transformed) {
        LayoutAgent.applyFocusModeLayer(v);
      }
    });

    document.getElementById("neuroadapt-level")?.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      state.simplificationLevel = v;
      LearningAgent.setSimplificationLevel(v);
    });

    document.getElementById("neuroadapt-theme")?.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      saveState({ theme: v });
      root.dataset.theme = v;
    });

    document.getElementById("neuroadapt-auto-high")?.addEventListener("change", (e) => {
      LearningAgent.setAutoHighLoad(/** @type {HTMLInputElement} */(e.target).checked);
      refreshMemoryLine();
    });

    document.getElementById("neuroadapt-profile")?.addEventListener("change", (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      LearningAgent.setNeuroProfile(v);
    });

    document.getElementById("neuroadapt-bionic-toggle")?.addEventListener("change", (e) => {
      const on = /** @type {HTMLInputElement} */(e.target).checked;
      LearningAgent.setBionicAnchors(on);
      if (on && state.transformed) {
          BionicAgent.enable();
      } else if (!on && state.transformed) {
          BionicAgent.disable();
      }
    });

    document.getElementById("neuroadapt-listen")?.addEventListener("click", () => {
      void toggleTTS();
    });

    document.getElementById("neuroadapt-lens-toggle")?.addEventListener("change", (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      saveState({ focusStrip: on });
      ReadingLens.setEnabled(on);
      if (on) {
        ReadingLens.scheduleUpdate();
      }
    });

    document.getElementById("neuroadapt-spacing-toggle")?.addEventListener("change", (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      saveState({ comfortSpacing: on });
      applyComfortSpacing(on);
    });

    document.getElementById("neuroadapt-motion-toggle")?.addEventListener("change", (e) => {
      const on = /** @type {HTMLInputElement} */ (e.target).checked;
      saveState({ reduceMotion: on });
      root.dataset.reduceMotion = on ? "1" : "0";
    });

    const optBtn = document.getElementById("neuroadapt-ai-settings");
    if (optBtn && extensionRuntimeOk()) {
      optBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
    } else if (optBtn) {
      optBtn.hidden = true;
    }

    if (!widgetWindowHooks) {
      widgetWindowHooks = true;
      window.addEventListener(
        "resize",
        () => {
          scheduleEnsureWidgetHost();
          const r = document.getElementById(WIDGET_HOST_ID);
          if (r) {
            clampPanelPosition(r);
          }
          ReadingLens.scheduleUpdate();
        },
        { passive: true }
      );
      let lastScrollY = window.scrollY;
      window.addEventListener("scroll", () => {
        scheduleEnsureWidgetHost();
        const currentY = window.scrollY;
        if (Math.abs(currentY - lastScrollY) > 80) {
           if (currentY > lastScrollY && !loadState().collapsed) {
               toggleCollapse(); // Auto-shrink away from central view
           }
           lastScrollY = currentY;
        }
      }, { passive: true, capture: true });
    }
  }

  function createWidget() {
    if (document.getElementById(WIDGET_HOST_ID)) {
      return;
    }

    setMachineState(Machine.OPENING);

    state.currentMode = LearningAgent.getPreferredMode();
    state.simplificationLevel = LearningAgent.getSimplificationLevel();

    const ui = loadState();
    const root = document.createElement("div");
    root.id = WIDGET_HOST_ID;
    root.className = "neuroadapt-root neuroadapt-root--enter";
    root.dataset.theme = ui.theme;
    root.dataset.state = Machine.OPENING;
    root.dataset.reduceMotion = ui.reduceMotion ? "1" : "0";

    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = "neuroadapt-surface";
    panel.setAttribute("aria-label", "NeuroAdapt cognitive load assistant");
    panel.setAttribute("aria-live", "polite");

    panel.innerHTML = `
      <header class="neuroadapt-panel-header">
        <div class="neuroadapt-drag-handle" title="Drag to move" role="button" tabindex="0">
          <span class="neuroadapt-drag-grip" aria-hidden="true">⋮⋮</span>
          <span class="neuroadapt-brand">NeuroAdapt</span>
        </div>
        <div class="neuroadapt-panel-actions">
          <button type="button" class="neuroadapt-icon-btn" id="neuroadapt-btn-collapse" aria-label="Collapse">−</button>
          <button type="button" class="neuroadapt-icon-btn" id="neuroadapt-btn-side" title="Dock left / right" aria-label="Switch side">⇄</button>
          <button type="button" class="neuroadapt-icon-btn neuroadapt-icon-btn--close" id="neuroadapt-btn-close" aria-label="Close">✕</button>
        </div>
      </header>
      <div class="neuroadapt-panel-scroll">
        <div class="neuroadapt-stress-row">
          <span class="neuroadapt-stress-badge" id="neuroadapt-stress">…</span>
        </div>
        <div class="neuroadapt-score-line" id="neuroadapt-score"></div>
        <div class="neuroadapt-smart-hint" id="neuroadapt-smart-hint" hidden></div>
        <div class="neuroadapt-narrative" id="neuroadapt-narrative"></div>
        <div class="neuroadapt-explain-title">Why this feels heavy</div>
        <ul class="neuroadapt-explanation" id="neuroadapt-explanation"></ul>
        <div class="neuroadapt-ai-status" id="neuroadapt-ai-status" hidden></div>
        <div class="neuroadapt-quick-cards">
          <button type="button" class="neuroadapt-chip" id="neuroadapt-simplify-section">Make This Easier</button>
          <button type="button" class="neuroadapt-chip" id="neuroadapt-key-points">Key points</button>
          <button type="button" class="neuroadapt-chip" id="neuroadapt-make-shorter">Make shorter</button>
          <button type="button" class="neuroadapt-chip" id="neuroadapt-summarize-page">Summarize Page</button>
          <button type="button" class="neuroadapt-chip" id="neuroadapt-quiz-page">Quiz Me!</button>
          <button type="button" class="neuroadapt-chip" id="neuroadapt-listen">🔊 Listen</button>
        </div>
        <pre class="neuroadapt-section-out" id="neuroadapt-section-out"></pre>
        <div class="neuroadapt-controls">
          <div>
            <div class="neuroadapt-label">Neuro-Profile Engine</div>
            <select id="neuroadapt-profile" class="neuroadapt-select" aria-label="Profile">
              <option value="default">Default</option>
              <option value="adhd">ADHD Focus</option>
              <option value="autism">Autism / Sensory</option>
              <option value="dyslexia">Dyslexia Support</option>
            </select>
          </div>
          <div>
            <div class="neuroadapt-label">Sensory theme</div>
            <select id="neuroadapt-theme" class="neuroadapt-select" aria-label="Theme">
              <option value="dark">Dark calm</option>
              <option value="pastel">Pastel soft</option>
              <option value="contrast">High contrast</option>
            </select>
          </div>
          <div>
            <div class="neuroadapt-label">Focus mode (Reduce Distractions)</div>
            <select id="neuroadapt-mode" class="neuroadapt-select" aria-label="Mode">
              <option value="${MODES.FOCUS}">Focus</option>
              <option value="${MODES.READING}">Reading</option>
              <option value="${MODES.QUICK_SCAN}">Quick scan</option>
            </select>
          </div>
          <div>
            <div class="neuroadapt-label">Simplification level</div>
            <select id="neuroadapt-level" class="neuroadapt-select" aria-label="Simplification">
              <option value="${LEVELS.LIGHT}">Light</option>
              <option value="${LEVELS.MEDIUM}">Medium</option>
              <option value="${LEVELS.AGGRESSIVE}">Aggressive</option>
            </select>
          </div>
        </div>
        <label class="neuroadapt-toggle-row">
          <input type="checkbox" id="neuroadapt-lens-toggle" />
          <span>Reading lens (focus strip)</span>
        </label>
        <label class="neuroadapt-toggle-row">
          <input type="checkbox" id="neuroadapt-bionic-toggle" />
          <span>Enable Bionic Anchors (ADHD)</span>
        </label>
        <label class="neuroadapt-toggle-row">
          <input type="checkbox" id="neuroadapt-spacing-toggle" />
          <span>Comfort spacing (main text)</span>
        </label>
        <label class="neuroadapt-toggle-row">
          <input type="checkbox" id="neuroadapt-motion-toggle" />
          <span>Reduce panel motion</span>
        </label>
        <label class="neuroadapt-checkbox-row">
          <input type="checkbox" id="neuroadapt-auto-high" />
          <span>Auto-enable reading lens when load is high (after frequent use)</span>
        </label>
        <button id="neuroadapt-fix-btn" type="button">✨ Reduce Distractions</button>
        <div class="neuroadapt-focus-note" id="neuroadapt-focus-note" hidden></div>
        <div class="neuroadapt-compare" id="neuroadapt-compare"></div>
        <div class="neuroadapt-changes" id="neuroadapt-changes"></div>
        <div class="neuroadapt-engagement" id="neuroadapt-engagement" aria-live="polite"></div>
        <div class="neuroadapt-memory" id="neuroadapt-memory"></div>
        <button type="button" class="neuroadapt-secondary-btn" id="neuroadapt-ai-settings">⚙️ AI model settings</button>
      </div>
    `;

    const fab = document.createElement("button");
    fab.type = "button";
    fab.id = "neuroadapt-fab";
    fab.className = "neuroadapt-fab";
    fab.setAttribute("aria-label", "Expand NeuroAdapt");
    fab.textContent = "🧠";
    fab.hidden = true;

    root.appendChild(panel);
    root.appendChild(fab);
    mountWidgetHostToDocument(root);

    state.panelElements = {
      stress: panel.querySelector("#neuroadapt-stress"),
      score: panel.querySelector("#neuroadapt-score"),
      smartHint: panel.querySelector("#neuroadapt-smart-hint"),
      narrative: panel.querySelector("#neuroadapt-narrative"),
      explanation: panel.querySelector("#neuroadapt-explanation"),
      focusNote: panel.querySelector("#neuroadapt-focus-note"),
      compare: panel.querySelector("#neuroadapt-compare"),
      changes: panel.querySelector("#neuroadapt-changes"),
      memory: panel.querySelector("#neuroadapt-memory"),
      engagement: panel.querySelector("#neuroadapt-engagement"),
      fixBtn: panel.querySelector("#neuroadapt-fix-btn")
    };

    bindPanelControls(root);
    applyUiStateToDom();

    const initial = runPipeline();
    if (!state.baselineMetrics) {
      state.baselineMetrics = initial;
    }
    updateScoreUI(initial);
    refreshMemoryLine();

    maybeAutoFocusLightweight(initial);

    requestAnimationFrame(() => {
      root.classList.remove("neuroadapt-root--enter");
    });
    setTimeout(() => {
      const r = document.getElementById(WIDGET_HOST_ID);
      if (r) {
        setMachineState(loadState().collapsed ? Machine.COLLAPSED : Machine.OPEN);
      }
    }, OPEN_ANIM_MS);

    handleOutsideClick();
    handleEscClose();
  }

  function maybeAutoFocusLightweight(metrics) {
    const high = metrics.score >= HIGH_LOAD_THRESHOLD;
    const habit = LearningAgent.shouldAutoApplyFromHabit();
    const pref = LearningAgent.getAutoHighLoad();
    if (!high || !(pref || habit)) {
      return;
    }
    saveState({ focusStrip: true });
    const lensCb = document.getElementById("neuroadapt-lens-toggle");
    if (lensCb) {
      lensCb.checked = true;
    }
    ReadingLens.setEnabled(true);
    ReadingLens.scheduleUpdate();
    const note = state.panelElements?.focusNote;
    if (note) {
      note.hidden = false;
      note.textContent =
        "⚠️ High load — reading lens on. Tap Fix this page when you want the full focus layer (still non-destructive).";
    }
  }

  function openWidget() {
    createWidget();
    saveState({ isOpen: true });
  }

  function closeWidget() {
    simplifyGeneration += 1;
    unwireGlobalHandlers();
    ReadingLens.teardown();
    applyComfortSpacing(false);

    const root = document.getElementById(WIDGET_HOST_ID);
    if (root) {
      root.remove();
    }

    state.panelElements = null;
    setMachineState(Machine.CLOSED);
    saveState({ isOpen: false });
  }

  function toggleWidget() {
    if (document.getElementById(WIDGET_HOST_ID)) {
      closeWidget();
    } else {
      openWidget();
    }
  }

  function initMessaging() {
    if (!extensionRuntimeOk()) {
      return;
    }
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "NEUROADAPT_TOGGLE") {
        toggleWidget();
        sendResponse?.({ ok: true });
      }
      return false;
    });
  }

  function migrateLegacyClicks() {
    if (localStorage.getItem(LS.fixClicks) != null) {
      return;
    }
    const legacy = localStorage.getItem("neuroadapt_fix_click_count");
    if (legacy != null) {
      localStorage.setItem(LS.fixClicks, legacy);
    }
  }

  function boot() {
    migrateLegacyClicks();
    initMessaging();
    if (loadState().isOpen) {
      openWidget();
    }
  }

  const BionicAgent = {
    enable() {
      let contentEls = document.querySelectorAll(".neuroadapt-readable-main p, .neuroadapt-readable-main li");
      if (!contentEls || contentEls.length === 0) {
        contentEls = document.querySelectorAll("p, article p, main p, .neuroadapt-section-out");
      }
      contentEls.forEach(el => {
        if (el.dataset.bionic === "1") return;
        el.dataset.bionic = "1";
        this.processNode(el);
      });
    },
    disable() {
      const contentEls = document.querySelectorAll("[data-bionic='1']");
      contentEls.forEach(el => {
        el.innerHTML = el.dataset.origHtml || el.innerHTML;
        delete el.dataset.bionic;
        delete el.dataset.origHtml;
      });
    },
    processNode(el) {
      if (!el.dataset.origHtml) el.dataset.origHtml = el.innerHTML;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
      const nodesToReplace = [];
      while (walker.nextNode()) {
        if (walker.currentNode.parentNode.tagName === 'B') continue;
        if (walker.currentNode.nodeValue.trim().length > 0) {
          nodesToReplace.push(walker.currentNode);
        }
      }
      nodesToReplace.forEach(node => {
        const text = node.nodeValue;
        const words = text.split(/([\s\p{P}]+)/u);
        const frag = document.createDocumentFragment();
        words.forEach(word => {
          if (!word.trim() || /^[^\p{L}\p{N}]+$/u.test(word)) {
            frag.appendChild(document.createTextNode(word));
            return;
          }
          const anchorLen = Math.max(1, Math.ceil(word.length * 0.45));
          const b = document.createElement("b");
          b.textContent = word.slice(0, anchorLen);
          b.style.fontWeight = "700";
          frag.appendChild(b);
          frag.appendChild(document.createTextNode(word.slice(anchorLen)));
        });
        node.parentNode.replaceChild(frag, node);
      });
    }
  };

  let ttsUtterance = null;
  function toggleTTS() {
    const btn = document.getElementById("neuroadapt-listen");
    if (window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      if (btn) btn.textContent = "🔊 Listen";
      return;
    }
    const outEl = document.getElementById("neuroadapt-section-out");
    let text = outEl ? outEl.textContent : "";
    if (!text || text.trim().length === 0) {
      text = extractVisibleContent().text;
    }
    if (!text || text.trim().length === 0) return;

    ttsUtterance = new SpeechSynthesisUtterance(text);
    ttsUtterance.onend = () => { if (btn) btn.textContent = "🔊 Listen"; };
    ttsUtterance.onerror = () => { if (btn) btn.textContent = "🔊 Listen"; };

    if (btn) btn.textContent = "⏹ Stop";
    window.speechSynthesis.speak(ttsUtterance);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
