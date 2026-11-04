const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const progressBarEl = document.getElementById("progressBar");
const autoScrollEl = document.getElementById("autoScroll");
const exportModeEl = document.getElementById("exportMode");
const maxSeekStepsEl = document.getElementById("maxSeekSteps");
const maxCollectScreensEl = document.getElementById("maxCollectScreens");
const maxApiPagesEl = document.getElementById("maxApiPages");
const apiPageSizeEl = document.getElementById("apiPageSize");
const apiStartAnchorEl = document.getElementById("apiStartAnchor");
const exportButtons = [document.getElementById("exportMarkdown"), document.getElementById("exportJson")];
const stopButton = document.getElementById("stopExport");
let currentExportId = "";
let currentTabId = 0;

document.getElementById("exportMarkdown").addEventListener("click", () => exportChat("markdown"));
document.getElementById("exportJson").addEventListener("click", () => exportChat("json"));
stopButton.addEventListener("click", stopExport);
installFloatingButtonOnActiveTab();

async function exportChat(format) {
  currentExportId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  currentTabId = 0;
  setBusy(true, "正在读取当前标签页...");
  setProgress(8);
  detailEl.textContent = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !getChatSite(tab.url || "")) {
      throw new Error("请先打开豆包或 DeepSeek 的对话详情页面。");
    }
    currentTabId = tab.id;

    const response = await sendExportMessage(tab, {
      type: "DOUBAO_EXPORT_CHAT_V2",
      exportId: currentExportId,
      format,
      autoScroll: autoScrollEl.checked,
      exportMode: exportModeEl.value,
      maxSeekSteps: readLimit(maxSeekStepsEl, 240),
      maxCollectScreens: readLimit(maxCollectScreensEl, 300),
      maxApiPages: readLimit(maxApiPagesEl, 1000, 1, 5000),
      apiPageSize: readLimit(apiPageSizeEl, 20, 1, 50),
      apiStartAnchor: readOptionalLimit(apiStartAnchorEl, 0, Number.MAX_SAFE_INTEGER)
    });

    if (!response?.ok) {
      throw new Error(response?.error || "没有拿到导出结果。");
    }

    const label = format === "markdown" ? "Markdown" : "JSON";
    setProgress(100);
    setBusy(false, `已导出 ${response.count} 条消息为 ${label}。`, "success");
    detailEl.textContent = response.filename || "";
  } catch (error) {
    setProgress(0);
    setBusy(false, error.message || String(error), "error");
  } finally {
    currentExportId = "";
    currentTabId = 0;
  }
}

async function stopExport() {
  if (!currentExportId || !currentTabId) return;

  stopButton.disabled = true;
  statusEl.textContent = "正在停止...";

  try {
    await sendExportMessage({ id: currentTabId }, {
      type: "DOUBAO_CANCEL_EXPORT",
      exportId: currentExportId
    });
  } catch (error) {
    setBusy(false, error.message || String(error), "error");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "DOUBAO_EXPORT_PROGRESS" || message.exportId !== currentExportId) return;

  const count = Number(message.count || 0);
  if (message.stage === "seek-top") {
    setProgress(25);
  } else if (message.stage === "api") {
    setProgress(Math.min(92, 18 + count * 2));
  } else if (message.stage === "fallback") {
    setProgress(12);
  } else if (message.stage === "collect") {
    setProgress(Math.min(92, 35 + count * 2));
  } else if (message.stage === "done") {
    setProgress(100);
  }

  statusEl.textContent = message.message || "正在导出...";
  detailEl.textContent = count ? `已识别 ${count} 条消息` : "";
});

async function sendExportMessage(tab, payload) {
  // 停止导出时不重新注入脚本，直接发给已经在跑的那份。
  const site = tab.url ? getChatSite(tab.url) : null;
  if (site) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [site.script]
    });
  }
  return chrome.tabs.sendMessage(tab.id, payload);
}

async function installFloatingButtonOnActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !getChatSite(tab.url || "")) return;
    await sendExportMessage(tab, { type: "DOUBAO_INSTALL_FLOATING_BUTTON" });
  } catch (_error) {
    // Ignore: the normal export button still injects the script before exporting.
  }
}

function getChatSite(value) {
  try {
    const url = new URL(value);
    if (/(^|\.)doubao\.com$/.test(url.hostname) && /^\/chat\/(?:bot\/chat\/)?\d+\/?$/.test(url.pathname)) {
      return { name: "doubao", script: "content.js" };
    }
    if (url.hostname === "chat.deepseek.com" && /^\/(?:a\/)?chat\/s\/[0-9a-zA-Z-]{8,}\/?$/.test(url.pathname)) {
      return { name: "deepseek", script: "deepseek-content.js" };
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function setBusy(isBusy, text, tone = "") {
  exportButtons.forEach((button) => {
    button.disabled = isBusy;
  });
  stopButton.disabled = !isBusy;
  statusEl.textContent = text;
  statusEl.className = tone;
}

function setProgress(percent) {
  progressBarEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}

function readLimit(input, fallback, min = 10, max = 1000) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readOptionalLimit(input, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!input.value.trim()) return undefined;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
