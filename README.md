# NeuroAdapt – AI-Powered Cognitive Accessibility Engine

This system combines feature-based cognitive load analysis with AI-powered text simplification and summarization to create a neuro-inclusive browsing experience.

## Description

NeuroAdapt is a Chrome extension that **measures** how demanding a page is to read, **explains why** using interpretable signals, **transforms** layout for readability, and uses a **real LLM** (OpenAI, Anthropic, or OpenAI-compatible APIs) to **simplify** difficult passages and **summarize** the main content. It keeps **before vs after** scores, **auto-focus** messaging, **personalization** via `localStorage`, and a clear **“changes applied”** checklist.

## AI integration

- **Where it runs:** All `fetch` calls happen in **`service-worker.js`** so the API key is not injected into web pages.
- **Modular entry point:** `callAI(prompt, systemInstruction)` performs async `fetch` to the configured provider and returns `{ ok, text?, error? }`.
- **Dev placeholder:** The constant `YOUR_API_KEY_HERE` is used when no key is stored — requests are **not** sent until you save a real key in **⚙️ AI model settings** (extension Options). **Do not commit production keys** in source; use Options + `chrome.storage.local`.

### How simplification works

1. **Smart extraction:** `ContentExtractorAgent` targets `main`, `article`, `[role=main]`, Wikipedia `#mw-content-text`, etc., and skips `nav`, `footer`, `aside`, headers, and ad-like class/id hints.
2. **Selective LLM use:** Only **paragraphs / list items** (and similar blocks) that are **dense** (≥120 words) or contain a sentence **>20 words** are sent — up to **22 blocks** per run to cap cost.
3. **Prompt:** The service worker sends the mandated instruction (short sentences, simple words, preserve meaning, **level**: light / medium / aggressive).
4. **Truncation:** Each block is capped at **~3500** characters before the API call.
5. **Fallback:** If the key is missing or the API errors, **`simplifyTextHeuristic`** (local rules) rewrites that block so the page still improves.

### How summarization works

1. Click **🧠 Summarize Page**.
2. The same **main-content** extractor gathers headings + paragraphs + list text (capped at **~14k** characters).
3. The service worker calls `callAI` with the tutor-style prompt (bullet points, short, plain language, beginner-friendly).
4. The result opens in a **modal**; errors are shown in plain language.

## Other features (preserved)

- Cognitive load **score** and **🟢🟡🔴** stress indicator  
- Human-like **narrative** + structured **“why this matters”** bullets  
- **✨ Fix this page** — distractions removed, layout/readability CSS, then LLM simplification  
- **Before vs after** score and **improvement %**  
- **High load** warning and optional **auto-apply** when preferences + habit match  
- **Learning** line: fix count, mode, simplification level, auto high-load  

## Installation

1. Open `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select `NeuroAdapt/extension`.
2. Open **⚙️ AI model settings**, choose provider, paste **API key**, set **model** (and **base URL** for custom).
3. Reload any tab where you want NeuroAdapt to run.

## Project layout

```
NeuroAdapt/
├── extension/
│   ├── manifest.json
│   ├── service-worker.js   ← callAI, LLM fetch
│   ├── options.html
│   ├── options.js
│   ├── content.js
│   └── styles.css
├── evaluation/
│   └── results.txt
└── README.md
```

## Limitations

- LLM output can occasionally soften nuance; review critical content (medical, legal).
- Replacing `textContent` on blocks **drops inline links/formatting** inside those blocks for simplicity.
- Very large SPAs may shift DOM after analysis; re-run if needed.

## Evaluation

See `evaluation/results.txt` for example before/after score deltas (scores depend on DOM and text at capture time).
