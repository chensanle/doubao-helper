(() => {
  const SCRIPT_VERSION = "0.1.0";
  const DISPLAY_VERSION = "0.4.0";
  const FLOATING_BUTTON_ID = "deepseek-export-floating-button";
  const FLOATING_POSITION_KEY = "deepseek-export-floating-position";
  const FLOATING_BUTTON_TEXT = `导出当前会话内容 v${DISPLAY_VERSION}`;
  if (window.__deepseekExportInstalled === SCRIPT_VERSION) return;
  window.__deepseekExportInstalled = SCRIPT_VERSION;
  const exportControllers = new Map();
  const observedHistories = [];
  injectPageHook();
  listenForObservedHistories();
  installFloatingExportButton();
  watchFloatingButtonRoute();

  // 和豆包的 content.js 共用同一套消息协议，popup 不需要区分站点。
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DOUBAO_CANCEL_EXPORT") {
      const controller = exportControllers.get(message.exportId);
      if (controller) {
        controller.cancelled = true;
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "当前没有正在运行的导出任务。" });
      }
      return false;
    }

    if (message?.type === "DOUBAO_INSTALL_FLOATING_BUTTON") {
      installFloatingExportButton();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== "DOUBAO_EXPORT_CHAT_V2") return false;

    exportChat(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  });

  async function exportChat(options) {
    const controller = { cancelled: false };
    if (options.exportId) exportControllers.set(options.exportId, controller);
    const progress = createProgressReporter(options.exportId);

    try {
      progress({ stage: "start", message: "开始读取当前对话", count: 0 });

      const limits = normalizeLimits(options);
      const result = await collectMessages(options, progress, controller, limits);

      checkCancelled(controller);
      if (!result.messages.length) {
        const apiError = result.meta?.apiError ? `（接口：${result.meta.apiError}）` : "";
        throw new Error(`没有识别到聊天内容，确认当前页面是 DeepSeek 对话页并等待加载完成。${apiError}`);
      }

      const payload = buildPayload(result.messages, result.meta, result.title);
      const format = options.format === "json" ? "json" : "markdown";
      const content = format === "json" ? JSON.stringify(payload, null, 2) : toMarkdown(payload);
      const mime = format === "json" ? "application/json" : "text/markdown";
      const ext = format === "json" ? "json" : "md";
      const filename = `deepseek-chat-${payload.chatId || "export"}-${timestampForFile()}.${ext}`;

      downloadText(filename, content, mime);
      progress({ stage: "done", message: `已生成 ${result.messages.length} 条消息`, count: result.messages.length });
      return { count: result.messages.length, filename };
    } finally {
      if (options.exportId) exportControllers.delete(options.exportId);
    }
  }

  async function collectMessages(options, progress, controller, limits) {
    const mode = options.exportMode || "api-first";

    if (mode === "api-only") {
      return collectByApi(progress, controller);
    }

    if (mode === "api-first") {
      try {
        const apiResult = await collectByApi(progress, controller);
        if (apiResult.messages.length) return apiResult;
        throw new Error("接口没有返回可导出的消息。");
      } catch (error) {
        checkCancelled(controller);
        progress({ stage: "fallback", message: `接口失败：${error.message || error}`, count: 0 });
        return {
          messages: options.autoScroll ? await collectByScrolling(progress, controller, limits) : collectVisibleMessages(),
          meta: {
            sourceMode: options.autoScroll ? "scroll-fallback" : "visible",
            stopReason: "api-failed",
            apiError: error.message || String(error)
          }
        };
      }
    }

    if (mode === "scroll-only") {
      return {
        messages: await collectByScrolling(progress, controller, limits),
        meta: { sourceMode: "scroll-only" }
      };
    }

    return {
      messages: options.autoScroll ? await collectByScrolling(progress, controller, limits) : collectVisibleMessages(),
      meta: { sourceMode: options.autoScroll ? "scroll" : "visible" }
    };
  }

  // ---------- 接口模式 ----------

  async function collectByApi(progress, controller) {
    const sessionId = getDeepseekSessionId(location.pathname);
    if (!sessionId) throw new Error("没有识别到 DeepSeek 会话 ID。");

    checkCancelled(controller);
    progress({ stage: "api", message: "正在通过接口读取会话", count: 0 });
    const result = await requestHistory(sessionId, controller);
    checkCancelled(controller);
    if (!result.ok) throw new Error(`接口请求失败：${result.error || "未知错误"}`);

    const bizData = getHistoryBizData(result.data);
    if (!bizData) throw new Error(`接口返回结构异常：${describeApiResponse(result.data)}`);

    const rawMessages = Array.isArray(bizData.chat_messages) ? bizData.chat_messages : [];
    const branch = selectCurrentBranch(rawMessages, bizData.chat_session?.current_message_id);
    const messages = [];
    for (const raw of branch.messages) {
      const parsed = parseApiMessage(raw);
      if (parsed.text || parsed.thinking) messages.push(parsed);
    }

    progress({ stage: "api", message: "接口读取完成", count: messages.length });
    return {
      messages,
      title: bizData.chat_session?.title || "",
      meta: {
        sourceMode: "api",
        stopReason: "complete",
        sessionId,
        requestSource: result.source,
        ...(result.fetchError ? { fetchError: result.fetchError } : {}),
        observedPageRequest: observedHistories.some((item) => item.sessionId === sessionId),
        rawCount: rawMessages.length,
        branchMode: branch.mode,
        currentMessageId: bizData.chat_session?.current_message_id ?? null
      }
    };
  }

  function requestHistory(sessionId, controller) {
    const requestId = randomId();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!controller?.cancelled) return;
        finish({ ok: false, error: "已停止导出。" });
      }, 200);
      const timeout = setTimeout(() => {
        finish({ ok: false, error: "页面接口脚本没有响应，可以刷新页面后重试，或改用滚动模式。" });
      }, 15000);

      function onMessage(event) {
        if (event.source !== window || event.origin !== location.origin) return;
        if (event.data?.type !== "DEEPSEEK_EXPORT_FETCH_RESULT" || event.data.requestId !== requestId) return;
        finish(event.data);
      }

      function finish(value) {
        clearInterval(timer);
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(value);
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ type: "DEEPSEEK_EXPORT_FETCH_REQUEST", requestId, sessionId }, location.origin);
    });
  }

  function getHistoryBizData(data) {
    if (!data || typeof data !== "object") return null;
    if (data.code !== undefined && Number(data.code) !== 0) return null;
    const inner = data.data;
    if (inner?.biz_code !== undefined && Number(inner.biz_code) !== 0) return null;
    const bizData = inner?.biz_data || data.biz_data;
    return Array.isArray(bizData?.chat_messages) ? bizData : null;
  }

  function describeApiResponse(data) {
    if (!data || typeof data !== "object") return typeof data;
    const parts = [`keys=${Object.keys(data).slice(0, 12).join(",") || "none"}`];
    ["code", "msg", "message"].forEach((key) => {
      if (data[key] !== undefined) parts.push(`${key}=${String(data[key]).slice(0, 120)}`);
    });
    ["biz_code", "biz_msg"].forEach((key) => {
      if (data.data?.[key] !== undefined) parts.push(`${key}=${String(data.data[key]).slice(0, 120)}`);
    });
    return parts.join(" ");
  }

  // DeepSeek 的消息是树：重新生成或编辑会产生分支。优先沿 current_message_id 往上走出当前分支。
  function selectCurrentBranch(rawMessages, currentMessageId) {
    const byId = new Map(rawMessages.map((raw) => [String(raw.message_id), raw]));
    const sorted = rawMessages.slice().sort((a, b) => Number(a.message_id || 0) - Number(b.message_id || 0));

    if (currentMessageId !== undefined && currentMessageId !== null && byId.has(String(currentMessageId))) {
      const chain = [];
      const visited = new Set();
      let cursor = byId.get(String(currentMessageId));
      while (cursor && !visited.has(String(cursor.message_id))) {
        visited.add(String(cursor.message_id));
        chain.unshift(cursor);
        if (cursor.parent_id === undefined || cursor.parent_id === null) break;
        cursor = byId.get(String(cursor.parent_id));
      }
      if (chain.length) return { mode: "current-branch", messages: chain };
    }

    return { mode: "all-by-id", messages: sorted };
  }

  function parseApiMessage(raw) {
    const role = String(raw.role || "").toLowerCase() === "user" ? "user" : "assistant";
    let text = "";
    let thinking = "";

    if (Array.isArray(raw.fragments) && raw.fragments.length) {
      const textParts = [];
      const thinkingParts = [];
      for (const fragment of raw.fragments) {
        const type = String(fragment?.type || "").toUpperCase();
        const content = typeof fragment?.content === "string" ? fragment.content : "";
        if (!content) continue;
        if (type === "THINK" || type === "THINKING") thinkingParts.push(content);
        else if (type === "REQUEST" || type === "RESPONSE" || type === "TEXT" || !type) textParts.push(content);
      }
      text = textParts.join("\n\n");
      thinking = thinkingParts.join("\n\n");
    } else {
      text = typeof raw.content === "string" ? raw.content : "";
      thinking = typeof raw.thinking_content === "string" ? raw.thinking_content : "";
    }

    const fileNames = (Array.isArray(raw.files) ? raw.files : [])
      .map((file) => file?.file_name || file?.name || "")
      .filter(Boolean);
    if (fileNames.length) {
      text = [text, `附件：${fileNames.join("、")}`].filter(Boolean).join("\n\n");
    }

    return {
      role,
      text: text.trim(),
      thinking: thinking.trim(),
      messageId: raw.message_id !== undefined && raw.message_id !== null ? String(raw.message_id) : "",
      raw
    };
  }

  // ---------- 滚动 / DOM 兜底 ----------

  async function collectByScrolling(progress, controller, limits) {
    const scroller = findScroller();
    if (!scroller) return collectVisibleMessages();

    const startTop = scroller.scrollTop;
    try {
      progress({ stage: "seek-top", message: "正在向上加载历史消息", count: 0 });
      await scrollToTop(scroller, progress, controller, limits);
      checkCancelled(controller);

      const ordered = [];
      mergeMessageWindow(ordered, collectVisibleMessages());

      let idleScreens = 0;
      let lastTop = scroller.scrollTop;
      let lastHeight = scroller.scrollHeight;

      for (let screen = 1; screen <= limits.maxCollectScreens; screen += 1) {
        checkCancelled(controller);
        const beforeCount = ordered.length;
        mergeMessageWindow(ordered, collectVisibleMessages());
        progress({ stage: "collect", message: `正在收集第 ${screen} 屏`, count: ordered.length });

        scroller.scrollTop = scroller.scrollTop + Math.max(360, scroller.clientHeight * 0.75);
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitForScrollSettle(scroller, controller);

        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
        const noMovement = Math.abs(scroller.scrollTop - lastTop) < 3;
        const noHeightChange = Math.abs(scroller.scrollHeight - lastHeight) < 3;
        const noNewMessages = ordered.length === beforeCount;
        idleScreens = noMovement && noHeightChange && noNewMessages ? idleScreens + 1 : 0;
        lastTop = scroller.scrollTop;
        lastHeight = scroller.scrollHeight;

        if (atBottom || idleScreens >= 5) {
          mergeMessageWindow(ordered, collectVisibleMessages());
          progress({ stage: "collect", message: "已到达对话底部", count: ordered.length });
          break;
        }
      }

      return ordered.length ? ordered : collectVisibleMessages();
    } finally {
      scroller.scrollTop = startTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  }

  async function scrollToTop(scroller, progress, controller, limits) {
    let idleSteps = 0;
    let lastTop = scroller.scrollTop;
    let lastHeight = scroller.scrollHeight;

    for (let i = 0; i < limits.maxSeekSteps; i += 1) {
      checkCancelled(controller);
      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(420, scroller.clientHeight * 0.9));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForScrollSettle(scroller, controller);

      const noMovement = Math.abs(scroller.scrollTop - lastTop) < 3;
      const noHeightChange = Math.abs(scroller.scrollHeight - lastHeight) < 3;
      const atTop = scroller.scrollTop <= 2;
      progress({ stage: "seek-top", message: `正在加载更早消息 ${i + 1}`, count: 0 });

      idleSteps = (atTop || noMovement) && noHeightChange ? idleSteps + 1 : 0;
      lastTop = scroller.scrollTop;
      lastHeight = scroller.scrollHeight;
      if (idleSteps >= 5) break;
    }
  }

  function mergeMessageWindow(target, incoming) {
    if (!incoming.length) return;
    if (!target.length) {
      target.push(...incoming);
      return;
    }

    const targetKeys = target.map(messageKey);
    const incomingKeys = incoming.map(messageKey);
    const maxOverlap = Math.min(targetKeys.length, incomingKeys.length);

    for (let size = maxOverlap; size > 0; size -= 1) {
      const targetTail = targetKeys.slice(targetKeys.length - size).join("\n---\n");
      const incomingHead = incomingKeys.slice(0, size).join("\n---\n");
      if (targetTail === incomingHead) {
        target.push(...incoming.slice(size));
        return;
      }
    }

    target.push(...incoming);
  }

  function messageKey(message) {
    return `${message.role}\n${normalizeText(message.text)}`;
  }

  function collectVisibleMessages() {
    return findRows()
      .map(extractMessage)
      .filter(Boolean);
  }

  // DeepSeek 的 class 名大多是混淆过的，这里只依赖相对稳定的 .ds-markdown（助手回答的 Markdown 容器）。
  function findRows() {
    const explicit = Array.from(document.querySelectorAll(".ds-message")).filter(hasRowText);
    if (explicit.length) return explicit;

    const answers = Array.from(document.querySelectorAll(".ds-markdown")).filter(
      (node) => !node.closest(".ds-think-content")
    );
    if (!answers.length) return [];

    const lists = new Map();
    for (const answer of answers) {
      const list = findMessageList(answer);
      if (list) lists.set(list, (lists.get(list) || 0) + 1);
    }
    const [list] = Array.from(lists.entries()).sort((a, b) => b[1] - a[1])[0] || [];
    if (!list) return [];
    return Array.from(list.children).filter(hasRowText);
  }

  // 从一条回答往上找，第一个"子元素里既有回答又有非回答文本块"的祖先就是消息列表。
  function findMessageList(answer) {
    let node = answer;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      const rows = Array.from(parent.children).filter(hasRowText);
      const withAnswer = rows.filter((row) => row.querySelector(".ds-markdown"));
      const withoutAnswer = rows.filter((row) => !row.querySelector(".ds-markdown"));
      if (withAnswer.length && withoutAnswer.length && rows.length >= 2) return parent;
      node = parent;
    }
    return null;
  }

  function hasRowText(row) {
    const text = normalizeText(row.innerText || row.textContent || "");
    return Boolean(text) && !row.querySelector("textarea,input,[contenteditable='true']");
  }

  function extractMessage(row, index) {
    const answers = Array.from(row.querySelectorAll(".ds-markdown")).filter(
      (node) => !node.closest(".ds-think-content")
    );
    if (answers.length) {
      const thinkNode = row.querySelector(".ds-think-content");
      const text = answers.map(cleanMessageText).filter(Boolean).join("\n\n");
      const thinking = thinkNode ? cleanMessageText(thinkNode) : "";
      if (!text && !thinking) return null;
      return { role: "assistant", text, thinking, index };
    }

    const text = cleanMessageText(row);
    if (!text || isChromeText(text)) return null;
    return { role: "user", text, thinking: "", index };
  }

  function cleanMessageText(node) {
    return normalizeText(node.innerText || node.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function isChromeText(text) {
    const blocked = new Set(["开启新对话", "新对话", "深度思考", "联网搜索", "发送"]);
    return blocked.has(text);
  }

  function findScroller() {
    const answer = document.querySelector(".ds-markdown");
    let node = answer?.parentElement;
    while (node && node !== document.documentElement) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }
    return findLargestScrollable(document.body);
  }

  function isScrollable(element) {
    if (!element) return false;
    const overflowY = getComputedStyle(element).overflowY;
    return element.scrollHeight > element.clientHeight + 40 && overflowY !== "visible" && overflowY !== "hidden";
  }

  function findLargestScrollable(root) {
    if (!root) return null;
    return Array.from(root.querySelectorAll("*"))
      .filter(isScrollable)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  }

  // ---------- 输出 ----------

  function buildPayload(messages, meta = {}, apiTitle = "") {
    return {
      source: "deepseek",
      url: location.href,
      title: apiTitle || document.title,
      chatId: getDeepseekSessionId(location.pathname) || location.pathname.split("/").filter(Boolean).pop() || "",
      exportedAt: new Date().toISOString(),
      meta,
      messages: messages.map(({ role, text, thinking, messageId, raw }, index) => ({
        index: index + 1,
        role,
        text,
        ...(thinking ? { thinking } : {}),
        ...(messageId ? { messageId } : {}),
        ...(raw ? { raw } : {})
      }))
    };
  }

  function toMarkdown(payload) {
    const lines = [
      "# DeepSeek 对话导出",
      "",
      `- 标题：${payload.title || "DeepSeek 对话"}`,
      `- URL：${payload.url}`,
      `- 导出时间：${payload.exportedAt}`,
      "",
      "## 对话",
      ""
    ];

    for (const message of payload.messages) {
      lines.push(`### ${message.role === "user" ? "用户" : "DeepSeek"}`, "");
      if (message.thinking) {
        lines.push("> **思考过程**", ">");
        message.thinking.split("\n").forEach((line) => lines.push(line ? `> ${line}` : ">"));
        lines.push("");
      }
      lines.push(message.text, "");
    }

    return lines.join("\n");
  }

  function downloadText(filename, content, mime) {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timestampForFile() {
    const offsetMs = new Date().getTimezoneOffset() * 60 * 1000;
    return new Date(Date.now() - offsetMs).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  async function waitForScrollSettle(scroller, controller) {
    let stable = 0;
    let lastTop = scroller.scrollTop;
    let lastHeight = scroller.scrollHeight;

    for (let i = 0; i < 12; i += 1) {
      checkCancelled(controller);
      await wait(120);
      checkCancelled(controller);
      const top = scroller.scrollTop;
      const height = scroller.scrollHeight;
      stable = Math.abs(top - lastTop) < 2 && Math.abs(height - lastHeight) < 2 ? stable + 1 : 0;
      lastTop = top;
      lastHeight = height;
      if (stable >= 2) break;
    }
  }

  // ---------- 页面 hook / 悬浮按钮 ----------

  function injectPageHook() {
    if (location.hostname !== "chat.deepseek.com") return;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("deepseek-page-hook.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function listenForObservedHistories() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type !== "DEEPSEEK_EXPORT_HISTORY_OBSERVED") return;
      const detail = event.data.detail;
      if (!detail?.sessionId) return;
      observedHistories.unshift(detail);
      observedHistories.splice(20);
      console.debug("[DeepSeek Export] observed history", detail);
    });
  }

  function shouldShowFloatingExportButton() {
    if (location.hostname !== "chat.deepseek.com") return false;
    return Boolean(getDeepseekSessionId(location.pathname));
  }

  function installFloatingExportButton() {
    if (!shouldShowFloatingExportButton()) {
      document.getElementById(FLOATING_BUTTON_ID)?.remove();
      return;
    }
    if (document.getElementById(FLOATING_BUTTON_ID)) return;

    const idleBackground = "#4d6bfe";
    const button = document.createElement("button");
    button.id = FLOATING_BUTTON_ID;
    button.type = "button";
    button.textContent = FLOATING_BUTTON_TEXT;
    button.title = `导出当前 DeepSeek 会话为 Markdown，插件版本 v${DISPLAY_VERSION}`;
    button.style.cssText = [
      "position:fixed",
      "top:72px",
      "right:20px",
      "left:auto",
      "z-index:2147483647",
      "height:36px",
      "padding:0 14px",
      "border:0",
      "border-radius:999px",
      `background:${idleBackground}`,
      "color:#fff",
      "box-shadow:0 8px 24px rgba(77,107,254,.28)",
      "font:600 14px/36px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "letter-spacing:0",
      "cursor:pointer",
      "user-select:none",
      "touch-action:none"
    ].join(";");
    applyFloatingButtonPosition(button);
    makeFloatingButtonDraggable(button);

    button.addEventListener("mouseenter", () => {
      if (!button.disabled) button.style.background = "#3b5bdb";
    });
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) button.style.background = idleBackground;
    });
    button.addEventListener("click", async () => {
      if (button.dataset.dragged === "1") return;
      if (button.disabled) return;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "导出中...";
      button.style.cursor = "wait";
      button.style.background = "#364fc7";

      try {
        // 接口拿不到时退回读取当前页面 DOM，不滚动页面。
        const result = await exportChat({
          format: "markdown",
          exportMode: "api-first",
          autoScroll: false,
          maxSeekSteps: 240,
          maxCollectScreens: 300
        });
        button.textContent = `已导出 ${result.count} 条`;
        button.style.background = "#16a34a";
        await wait(1600);
      } catch (error) {
        button.textContent = "导出失败";
        button.style.background = "#dc2626";
        console.warn("[DeepSeek Export]", error);
        await wait(1800);
      } finally {
        button.disabled = false;
        button.textContent = originalText;
        button.style.cursor = "pointer";
        button.style.background = idleBackground;
      }
    });

    const append = () => {
      if (document.body && !document.getElementById(button.id)) {
        document.body.appendChild(button);
      }
    };

    append();
    document.addEventListener("DOMContentLoaded", append, { once: true });
    setTimeout(append, 600);
    setTimeout(append, 1800);
  }

  function watchFloatingButtonRoute() {
    if (window.__deepseekExportRouteWatcherInstalled) return;
    window.__deepseekExportRouteWatcherInstalled = true;
    let lastUrl = location.href;

    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      installFloatingExportButton();
    }, 800);

    window.addEventListener("resize", () => {
      const button = document.getElementById(FLOATING_BUTTON_ID);
      if (!button) return;
      const rect = button.getBoundingClientRect();
      moveFloatingButton(button, rect.left, rect.top);
      saveFloatingButtonPosition(button);
    });
  }

  function makeFloatingButtonDraggable(button) {
    let drag = null;

    button.addEventListener("pointerdown", (event) => {
      if (button.disabled || event.button !== 0) return;
      const rect = button.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        moved: false
      };
      button.setPointerCapture?.(event.pointerId);
    });

    button.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < 4 && !drag.moved) return;
      drag.moved = true;
      event.preventDefault();
      moveFloatingButton(button, event.clientX - drag.offsetX, event.clientY - drag.offsetY);
    });

    button.addEventListener("pointerup", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      button.releasePointerCapture?.(event.pointerId);
      if (drag.moved) {
        button.dataset.dragged = "1";
        saveFloatingButtonPosition(button);
        setTimeout(() => {
          delete button.dataset.dragged;
        }, 0);
      }
      drag = null;
    });

    button.addEventListener("pointercancel", () => {
      drag = null;
    });
  }

  function applyFloatingButtonPosition(button) {
    const saved = readFloatingButtonPosition();
    if (saved) moveFloatingButton(button, saved.left, saved.top);
  }

  function moveFloatingButton(button, left, top) {
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    button.style.left = `${Math.round(Math.min(maxLeft, Math.max(margin, left)))}px`;
    button.style.top = `${Math.round(Math.min(maxTop, Math.max(margin, top)))}px`;
    button.style.right = "auto";
  }

  function saveFloatingButtonPosition(button) {
    const rect = button.getBoundingClientRect();
    try {
      localStorage.setItem(
        FLOATING_POSITION_KEY,
        JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })
      );
    } catch (_error) {}
  }

  function readFloatingButtonPosition() {
    try {
      const value = JSON.parse(localStorage.getItem(FLOATING_POSITION_KEY) || "null");
      if (!value || !Number.isFinite(value.left) || !Number.isFinite(value.top)) return null;
      return value;
    } catch (_error) {
      return null;
    }
  }

  // ---------- 工具函数 ----------

  function createProgressReporter(exportId) {
    return (detail) => {
      if (!exportId) return;
      chrome.runtime
        .sendMessage({ type: "DOUBAO_EXPORT_PROGRESS", exportId, ...detail })
        .catch(() => {});
    };
  }

  function normalizeLimits(options) {
    return {
      maxSeekSteps: clampInteger(options.maxSeekSteps, 240),
      maxCollectScreens: clampInteger(options.maxCollectScreens, 300)
    };
  }

  function clampInteger(value, fallback, min = 10, max = 1000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  function checkCancelled(controller) {
    if (controller?.cancelled) {
      throw new Error("已停止导出。");
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getDeepseekSessionId(pathname) {
    const match = String(pathname || "").match(/^\/(?:a\/)?chat\/s\/([0-9a-zA-Z-]{8,})\/?$/);
    return match ? match[1] : "";
  }

  function randomId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
