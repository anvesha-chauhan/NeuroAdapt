const KEYS = {
  provider: "neuroadapt_ai_provider",
  apiKey: "neuroadapt_ai_api_key",
  model: "neuroadapt_ai_model",
  baseUrl: "neuroadapt_ai_base_url"
};

function $(id) {
  return document.getElementById(id);
}

async function load() {
  const data = await chrome.storage.local.get([
    KEYS.provider,
    KEYS.apiKey,
    KEYS.model,
    KEYS.baseUrl
  ]);
  $("provider").value = data[KEYS.provider] || "openai";
  $("api-key").value = data[KEYS.apiKey] || "";
  $("model").value = data[KEYS.model] || "gpt-4o-mini";
  $("base-url").value = data[KEYS.baseUrl] || "";
}

async function save() {
  await chrome.storage.local.set({
    [KEYS.provider]: $("provider").value,
    [KEYS.apiKey]: $("api-key").value.trim(),
    [KEYS.model]: $("model").value.trim() || "gpt-4o-mini",
    [KEYS.baseUrl]: $("base-url").value.trim()
  });
  const st = $("status");
  st.textContent = "Saved.";
  setTimeout(() => {
    st.textContent = "";
  }, 2500);
}

document.addEventListener("DOMContentLoaded", () => {
  load();
  $("save").addEventListener("click", save);
});
