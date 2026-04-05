/**
 * NeuroAdapt — AI-Powered Cognitive Accessibility Engine
 * Service worker: all LLM traffic runs here (keys never touch page DOM).
 *
 * SECURITY: Do NOT commit real API keys to source control. For production, users must
 * set the key in the extension Options page (chrome.storage.local). The literal
 * "YOUR_API_KEY_HERE" is a dev placeholder only — replace it in Options, not in git.
 */
const YOUR_API_KEY_HERE = "YOUR_API_KEY_HERE";

const STORAGE_KEYS = {
  provider: "neuroadapt_ai_provider",
  apiKey: "neuroadapt_ai_api_key",
  model: "neuroadapt_ai_model",
  baseUrl: "neuroadapt_ai_base_url"
};

async function getStoredSettings() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.provider,
    STORAGE_KEYS.apiKey,
    STORAGE_KEYS.model,
    STORAGE_KEYS.baseUrl
  ]);
  return {
    provider: data[STORAGE_KEYS.provider] || "openai",
    apiKey: (data[STORAGE_KEYS.apiKey] || "").trim(),
    model: data[STORAGE_KEYS.model] || "gpt-4o-mini",
    baseUrl: (data[STORAGE_KEYS.baseUrl] || "").trim()
  };
}

function resolvedApiKey(storedKey) {
  const k = (storedKey || "").trim();
  return k || YOUR_API_KEY_HERE;
}

/** Hard caps for prompts — content script also truncates; this is a safety net. */
const MAX_SUMMARY_INPUT_CHARS = 5000;
const MAX_SIMPLIFY_INPUT_CHARS = 3000;

function truncatePromptText(text, maxChars) {
  if (text == null || typeof text !== "string") {
    return "";
  }
  const s = text.trim();
  return s.length <= maxChars ? s : s.slice(0, maxChars);
}

/** Offline-style bullets from excerpt when the LLM fails or times out (never empty for non-empty input). */
function buildLocalSummaryFromText(pageText) {
  const flat = pageText.replace(/\s+/g, " ").trim();
  if (!flat) {
    return "No text available to summarize.";
  }
  const chunk = flat.slice(0, MAX_SUMMARY_INPUT_CHARS);
  const parts = chunk.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  const lines = (parts.length ? parts : [chunk]).slice(0, 6).map((s) => {
    const line = s.length > 320 ? `${s.slice(0, 317)}…` : s;
    return `• ${line}`;
  });
  return `Quick overview (automatic fallback — AI unavailable or failed):\n\n${lines.join("\n\n")}`;
}

/**
 * Modular LLM entry: single async pipeline for any prompt.
 * @param {string} prompt - User / task prompt (plain text).
 * @param {string} [systemInstruction] - Optional system message.
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
async function callAI(prompt, systemInstruction) {
  const settings = await getStoredSettings();
  const apiKey = resolvedApiKey(settings.apiKey);

  if (apiKey === YOUR_API_KEY_HERE) {
    return {
      ok: false,
      error:
        "API key not configured. Open NeuroAdapt → ⚙️ AI model settings and paste your key (never ship real keys in code)."
    };
  }

  const system =
    systemInstruction ||
    "You support neuro-inclusive reading. Follow the user instructions exactly. Output plain text only unless bullets are requested.";

  try {
    if (settings.provider === "anthropic") {
      const text = await fetchAnthropic({
        apiKey,
        model: settings.model,
        system,
        user: prompt
      });
      return { ok: true, text };
    }

    const baseUrl =
      settings.provider === "custom" && settings.baseUrl
        ? settings.baseUrl.replace(/\/$/, "")
        : "https://api.openai.com/v1";

    const text = await fetchOpenAICompatible({
      apiKey,
      model: settings.model,
      baseUrl,
      system,
      user: prompt
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function fetchOpenAICompatible({ apiKey, model, baseUrl, system, user }) {
  const url = `${baseUrl}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.25,
      max_tokens: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM ${res.status}: ${errText.slice(0, 240)}`);
  }
  const json = await res.json();
  const out = json?.choices?.[0]?.message?.content;
  if (!out || typeof out !== "string") {
    throw new Error("Unexpected chat completions response");
  }
  return out.trim();
}

async function fetchAnthropic({ apiKey, model, system, user }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model || "claude-3-5-haiku-20241022",
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 240)}`);
  }
  const json = await res.json();
  const block = json?.content?.[0];
  const out = block?.type === "text" ? block.text : "";
  if (!out || typeof out !== "string") {
    throw new Error("Unexpected Anthropic response");
  }
  return out.trim();
}

function buildSimplifyPrompt(text, level) {
  const lvl = (level || "medium").toLowerCase();
  return `Rewrite the following text in simple, clear, beginner-friendly language. Focus on lowering cognitive load.
- Output either 3-5 short bullet points OR a short 2-3 line explanation.
- Avoid complex words and jargon.
- Maintain meaning perfectly.
- Level: ${lvl}

TEXT:
${text}`;
}

function buildSummarizePrompt(pageText) {
  return `Summarize this webpage in beginner-friendly language with low cognitive load.
- Output exactly 3-5 short bullet points
- Keep it highly concise
- Avoid jargon completely
- Make it extremely accessible

PAGE CONTENT:
${pageText}`;
}

function buildKeyPointsPrompt(text) {
  return `From the excerpt below, list only the 3–5 most important ideas for a reader with ADHD or cognitive fatigue.
- Use plain language
- Each point one short line
- Start each line with "• "
- No introduction or conclusion

EXCERPT:
${text}`;
}

function getSystemConstraint(baseSystem, neuroProfile) {
  let constraint = baseSystem;
  if (neuroProfile === "autism") {
      constraint = "YOU ARE AN EXPERT COMMUNICATOR FOR INDIVIDUALS ON THE AUTISM SPECTRUM. YOUR ONLY JOB IS TO REWRITE TEXT. " + baseSystem + " YOU MUST STRIP OUT ALL SARCASM, IDIOMS, METAPHORS, ANALOGIES, AND FIGURATIVE LANGUAGE. DO NOT USE COLORFUL LANGUAGE. SPEAK WITH 100% EXPLICIT, LITERAL FACTUALITY.";
  } else if (neuroProfile === "dyslexia") {
      constraint += " Use highly concrete vocabulary, avoid visually similar words, and keep syntax perfectly linear and direct.";
  }
  return constraint;
}

async function simplifyTextLLM(text, level, neuroProfile) {
  const safe = truncatePromptText(text, MAX_SIMPLIFY_INPUT_CHARS);
  const prompt = buildSimplifyPrompt(safe, level);
  const system = getSystemConstraint("You rewrite text for cognitive accessibility. Output only the rewritten passage, no preamble or quotes.", neuroProfile);
  return callAI(prompt, system);
}

async function keyPointsLLM(text, neuroProfile) {
  const safe = truncatePromptText(text, MAX_SIMPLIFY_INPUT_CHARS);
  const prompt = buildKeyPointsPrompt(safe);
  const system = getSystemConstraint("You extract key ideas for accessibility. Output only bullet lines with • , nothing else.", neuroProfile);
  return callAI(prompt, system);
}

async function summarizePageLLM(pageText, neuroProfile) {
  const safe = truncatePromptText(pageText, MAX_SUMMARY_INPUT_CHARS);
  const prompt = buildSummarizePrompt(safe);
  const system = getSystemConstraint("You summarize web articles for beginners. Use bullet points with leading • or -. Stay concise.", neuroProfile);
  return callAI(prompt, system);
}

function buildQuizPrompt(text) {
  return `Generate a 3-question active recall quiz based on the following text to help a reader with ADHD or cognitive fatigue retain information.
- Provide 3 Multiple Choice or True/False questions.
- Keep the questions simple and direct.
- Put the answer key at the very bottom.

EXCERPT:
${text}`;
}

async function quizPageLLM(pageText, neuroProfile) {
  const safe = truncatePromptText(pageText, MAX_SUMMARY_INPUT_CHARS);
  const prompt = buildQuizPrompt(safe);
  const system = getSystemConstraint("You are an educational assistant. Generate a highly readable quiz. Use clear line breaks.", neuroProfile);
  return callAI(prompt, system);
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id || tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "NEUROADAPT_TOGGLE" }, () => void chrome.runtime.lastError);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_AI_SETTINGS") {
    getStoredSettings()
      .then((s) => {
        const key = resolvedApiKey(s.apiKey);
        sendResponse({
          ok: true,
          settings: {
            provider: s.provider,
            model: s.model,
            baseUrl: s.baseUrl,
            hasConfiguredKey: key !== YOUR_API_KEY_HERE
          }
        });
      })
      .catch((e) =>
        sendResponse({
          ok: false,
          settings: { hasConfiguredKey: false },
          error: e?.message || String(e)
        })
      );
    return true;
  }

  if (message?.type === "SIMPLIFY_TEXT") {
    simplifyTextLLM(message.text, message.level, message.neuroProfile)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  if (message?.type === "KEY_POINTS_TEXT") {
    keyPointsLLM(message.text, message.neuroProfile)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }

  if (message?.type === "SUMMARIZE_PAGE") {
    const raw = message.payload ?? message.text ?? "";
    const payload = typeof raw === "string" ? raw : String(raw);
    const safe = truncatePromptText(payload, MAX_SUMMARY_INPUT_CHARS);
    if (!safe) {
      sendResponse({
        ok: false,
        summary: null,
        error: "No text to summarize — try a page with paragraph content."
      });
      return true;
    }
    summarizePageLLM(safe, message.neuroProfile)
      .then((r) => {
        if (r.ok && typeof r.text === "string" && r.text.trim()) {
          sendResponse({ ok: true, summary: r.text.trim() });
          return;
        }
        sendResponse({
          ok: true,
          summary: buildLocalSummaryFromText(safe),
          error: r.error || "AI summary failed — showing excerpt instead.",
          fallback: true
        });
      })
      .catch((e) => {
        sendResponse({
          ok: true,
          summary: buildLocalSummaryFromText(safe),
          error: e?.message || String(e),
          fallback: true
        });
      });
    return true;
  }

  if (message?.type === "QUIZ_PAGE") {
    const raw = message.payload ?? message.text ?? "";
    const payload = typeof raw === "string" ? raw : String(raw);
    const safe = truncatePromptText(payload, MAX_SUMMARY_INPUT_CHARS);
    if (!safe) {
      sendResponse({ ok: false, text: null, error: "No text for quiz." });
      return true;
    }
    quizPageLLM(safe, message.neuroProfile)
      .then((r) => {
        if (r.ok && typeof r.text === "string" && r.text.trim()) {
          sendResponse({ ok: true, text: r.text.trim() });
        } else {
          sendResponse({ ok: false, error: r.error || "Quiz generation failed." });
        }
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message?.type === "CALL_AI_RAW") {
    callAI(message.prompt, message.system).then(sendResponse);
    return true;
  }

  return false;
});
