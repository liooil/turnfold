const languageButtons = [...document.querySelectorAll("[data-set-lang]")];

function setLanguage(language, persist = true) {
  const next = language === "en" ? "en" : "zh";
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.language = next;
  document.title = next === "zh"
    ? "Turnfold — 本地优先的 AI 对话仓库"
    : "Turnfold — Local-first AI conversations";
  languageButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.setLang === next));
  });
  if (persist) localStorage.setItem("turnfold-site-language", next);
}

languageButtons.forEach((button) => {
  button.addEventListener("click", () => setLanguage(button.dataset.setLang));
});

const requestedLanguage = new URLSearchParams(location.search).get("lang");
const savedLanguage = localStorage.getItem("turnfold-site-language");
const browserLanguage = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
setLanguage(requestedLanguage || savedLanguage || browserLanguage, false);

document.querySelector("#copy-command")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const command = document.querySelector("#quick-command")?.textContent || "";
  try {
    await navigator.clipboard.writeText(command);
    const language = document.documentElement.dataset.language;
    button.textContent = language === "zh" ? "已复制" : "Copied";
    window.setTimeout(() => {
      button.innerHTML = '<span data-lang="zh">复制</span><span data-lang="en">Copy</span>';
    }, 1600);
  } catch {
    window.getSelection()?.selectAllChildren(document.querySelector("#quick-command"));
  }
});
