(() => {
  const SCRIPT_VERSION = "0.5.3";
  const DISPLAY_VERSION = "0.4.0";
  const FLOATING_BUTTON_TEXT = `导出当前会话内容 v${DISPLAY_VERSION}`;
  if (window.__doubaoExportInstalled === SCRIPT_VERSION) return;
  window.__doubaoExportInstalled = SCRIPT_VERSION;
  const exportControllers = new Map();
  const observedSingleChains = [];
  injectPageHook();
  listenForObservedSingleChains();
  installFloatingExportButton();
  watchFloatingButtonRoute();

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
      const messages = Array.isArray(result) ? result : result.messages;
      const exportMeta = Array.isArray(result) ? {} : result.meta;

      checkCancelled(controller);
      if (!messages.length) {
        throw new Error("没有识别到聊天内容，确认当前页面是豆包对话页并等待加载完成。");
      }

      const payload = buildPayload(messages, exportMeta);
      const format = options.format === "json" ? "json" : "markdown";
      const content = format === "json" ? JSON.stringify(payload, null, 2) : toMarkdown(payload);
      const mime = format === "json" ? "application/json" : "text/markdown";
      const ext = format === "json" ? "json" : "md";
      const filename = `doubao-chat-${payload.chatId || "export"}-${timestampForFile()}.${ext}`;

      downloadText(filename, content, mime);
      progress({ stage: "done", message: `已生成 ${messages.length} 条消息`, count: messages.length });
      return { count: messages.length, filename };
    } finally {
      if (options.exportId) exportControllers.delete(options.exportId);
    }
  }

  function installFloatingExportButton() {
    if (!shouldShowFloatingExportButton()) {
      removeFloatingExportButton();
      return;
    }
    if (document.getElementById("doubao-export-floating-button")) return;

    const button = document.createElement("button");
    button.id = "doubao-export-floating-button";
    button.type = "button";
    button.textContent = FLOATING_BUTTON_TEXT;
    button.title = `导出当前豆包会话为 Markdown，插件版本 v${DISPLAY_VERSION}`;
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
      "background:#e11d48",
      "color:#fff",
      "box-shadow:0 8px 24px rgba(225,29,72,.28)",
      "font:600 14px/36px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "letter-spacing:0",
      "cursor:pointer",
      "user-select:none",
      "touch-action:none"
    ].join(";");
    applyFloatingButtonPosition(button);
    makeFloatingButtonDraggable(button);

    button.addEventListener("mouseenter", () => {
      if (!button.disabled) button.style.background = "#be123c";
    });
    button.addEventListener("mouseleave", () => {
      if (!button.disabled) button.style.background = "#e11d48";
    });
    button.addEventListener("click", async () => {
      if (button.dataset.dragged === "1") return;
      if (button.disabled) return;
      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = "导出中...";
      button.style.cursor = "wait";
      button.style.background = "#9f1239";

      try {
        const result = await exportChat({
          format: "markdown",
          exportMode: "api-only",
          autoScroll: false,
          maxSeekSteps: 240,
          maxCollectScreens: 300,
          maxApiPages: 1000,
          apiPageSize: 20,
          apiStartAnchor: undefined
        });
        button.textContent = `已导出 ${result.count} 条`;
        button.style.background = "#16a34a";
        await wait(1600);
      } catch (error) {
        button.textContent = "导出失败";
        button.style.background = "#dc2626";
        console.warn("[Doubao Export]", error);
        await wait(1800);
      } finally {
        button.disabled = false;
        button.textContent = originalText;
        button.style.cursor = "pointer";
        button.style.background = "#e11d48";
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

  function injectPageHook() {
    if (!/(^|\.)doubao\.com$/.test(location.hostname)) return;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-hook.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.documentElement || document.head).appendChild(script);
  }

  function listenForObservedSingleChains() {
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.type !== "DOUBAO_EXPORT_CHAIN_OBSERVED") return;
      const detail = event.data.detail;
      if (!detail?.conversationId) return;
      observedSingleChains.unshift(detail);
      observedSingleChains.splice(20);
      console.debug("[Doubao Export] observed chain", detail);
    });
  }

  function shouldShowFloatingExportButton() {
    if (!/(^|\.)doubao\.com$/.test(location.hostname)) return false;
    return Boolean(getDoubaoChatIdFromPath(location.pathname));
  }

  function removeFloatingExportButton() {
    document.getElementById("doubao-export-floating-button")?.remove();
  }

  function watchFloatingButtonRoute() {
    if (window.__doubaoExportRouteWatcherInstalled) return;
    window.__doubaoExportRouteWatcherInstalled = true;
    let lastUrl = location.href;

    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      installFloatingExportButton();
    }, 800);

    window.addEventListener("resize", () => {
      const button = document.getElementById("doubao-export-floating-button");
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
    if (saved) {
      moveFloatingButton(button, saved.left, saved.top);
    }
  }

  function moveFloatingButton(button, left, top) {
    const margin = 8;
    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const nextLeft = Math.min(maxLeft, Math.max(margin, left));
    const nextTop = Math.min(maxTop, Math.max(margin, top));

    button.style.left = `${Math.round(nextLeft)}px`;
    button.style.top = `${Math.round(nextTop)}px`;
    button.style.right = "auto";
  }

  function saveFloatingButtonPosition(button) {
    const rect = button.getBoundingClientRect();
    try {
      localStorage.setItem(
        "doubao-export-floating-position",
        JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })
      );
    } catch (_error) {}
  }

  function readFloatingButtonPosition() {
    try {
      const value = JSON.parse(localStorage.getItem("doubao-export-floating-position") || "null");
      if (!value || !Number.isFinite(value.left) || !Number.isFinite(value.top)) return null;
      return value;
    } catch (_error) {
      return null;
    }
  }

  async function collectMessages(options, progress, controller, limits) {
    const mode = options.exportMode || "api-first";

    if (mode === "api-only") {
      return collectByApi(progress, controller, limits);
    }

    if (mode === "api-first") {
      try {
        const apiMessages = await collectByApi(progress, controller, limits);
        if (apiMessages.messages.length) return apiMessages;
        throw new Error("接口没有返回可导出的消息。");
      } catch (error) {
        checkCancelled(controller);
        if (Array.isArray(error.partialMessages) && error.partialMessages.length) {
          progress({
            stage: "api",
            message: `接口中途停止，已保留 ${error.partialMessages.length} 条接口数据`,
            count: error.partialMessages.length
          });
          return {
            messages: error.partialMessages,
            meta: { sourceMode: "api", stopReason: error.message || "接口中途停止" }
          };
        }
        progress({
          stage: "fallback",
          message: `接口失败：${error.message || error}`,
          count: 0
        });
        if (!options.autoScroll) throw error;
        return {
          messages: options.autoScroll ? await collectByScrolling(progress, controller, limits) : collectVisibleMessages(),
          meta: { sourceMode: options.autoScroll ? "scroll-fallback" : "visible", stopReason: "api-empty" }
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

  async function collectByApi(progress, controller, limits) {
    const chatInfo = getDoubaoChatInfo();
    const initialPage = await resolveInitialApiPage(chatInfo, limits, progress, controller);
    const conversationId = initialPage.conversationId;
    if (!conversationId) throw new Error("没有识别到可用 conversation_id。");

    const messages = [];
    const seen = new Set();
    const seenAnchors = new Set();
    const seenPages = new Set();
    let anchorIndex = initialPage.anchorIndex;
    let direction = initialPage.direction;
    let hasMore = true;
    let repeatedPages = 0;
    let rawCount = 0;
    let lastAnchor = anchorIndex;
    let stopReason = "complete";
    let prefetchedPageData = initialPage.firstPageData || null;

    for (let page = 1; page <= limits.maxApiPages && hasMore; page += 1) {
      checkCancelled(controller);
      progress({
        stage: "api",
        message: `接口拉取第 ${page} 页，Anchor ${anchorIndex}`,
        count: messages.length
      });
      const currentAnchor = anchorIndex;
      seenAnchors.add(currentAnchor);

      let data;
      if (prefetchedPageData) {
        data = prefetchedPageData;
        prefetchedPageData = null;
      } else {
        try {
          data = await requestSingleChain({
            conversationId,
            anchorIndex: currentAnchor,
            direction,
            limit: limits.apiPageSize,
            url: initialPage.url
          });
        } catch (error) {
          throw attachPartialMessages(error, buildApiResult(messages));
        }
      }

      const body = getSingleChainBody(data);

      if (!body) {
        const error = new Error(`接口返回结构异常：${describeApiResponse(data)}`);
        const partialMessages = buildApiResult(messages);
        if (partialMessages.length) {
          stopReason = "unexpected-response-body";
          progress({
            stage: "api",
            message: `接口后续页结构异常，已保留 ${partialMessages.length} 条`,
            count: partialMessages.length
          });
          break;
        }
        throw attachPartialMessages(error, partialMessages);
      }

      const pageMessages = Array.isArray(body.messages) ? body.messages : [];
      hasMore = Boolean(body.has_more);

      if (!pageMessages.length) break;
      rawCount += pageMessages.length;

      const pageKey = pageMessages.map(getApiMessageIdentity).join("|");
      const beforeCount = messages.length;

      for (const raw of pageMessages) {
        const parsed = parseApiMessage(raw);
        const key = parsed.messageId || `${parsed.index}:${parsed.role}:${parsed.text}`;
        if (parsed.text && !seen.has(key)) {
          seen.add(key);
          messages.push(parsed);
        }
      }

      const addedCount = messages.length - beforeCount;
      if (seenPages.has(pageKey)) {
        repeatedPages += 1;
      } else {
        repeatedPages = 0;
        seenPages.add(pageKey);
      }

      if (!hasMore) {
        stopReason = "no-more";
        break;
      }
      if (repeatedPages >= 2) {
        stopReason = "repeated-page";
        progress({
          stage: "api",
          message: "接口返回重复分页，已停止避免死循环",
          count: messages.length
        });
        break;
      }

      const next = getNextApiAnchor(body, pageMessages, currentAnchor);
      let nextAnchor = next.anchor;

      if (!nextAnchor || seenAnchors.has(nextAnchor)) {
        nextAnchor = getFallbackApiAnchor(pageMessages, currentAnchor);
      }

      if (!nextAnchor || seenAnchors.has(nextAnchor)) {
        stopReason = "missing-next-anchor";
        progress({
          stage: "api",
          message: `接口还有更多内容，但没有识别到下一页 Anchor。原始 ${rawCount} 条，可导出 ${messages.length} 条`,
          count: messages.length
        });
        break;
      }

      if (!addedCount) {
        progress({
          stage: "api",
          message: `第 ${page} 页没有可导出文本，继续查找后续历史`,
          count: messages.length
        });
      }

      anchorIndex = nextAnchor;
      lastAnchor = nextAnchor;
      direction = 1;

      if (page === limits.maxApiPages) {
        stopReason = "max-api-pages";
      }
    }

    progress({ stage: "api", message: "接口拉取完成", count: messages.length });
    return {
      messages: buildApiResult(messages),
      meta: {
        sourceMode: "api",
        stopReason,
        chatPathType: chatInfo.type,
        urlChatId: chatInfo.id,
        conversationId,
        initialAnchor: initialPage.anchorIndex,
        initialDirection: initialPage.direction,
        apiStartAnchorSource: initialPage.source,
        rawCount,
        lastAnchor,
        maxApiPages: limits.maxApiPages,
        apiPageSize: limits.apiPageSize
      }
    };
  }

  function buildApiResult(messages) {
    return messages
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
      .map(({ role, text, index, messageId, raw }) => ({ role, text, index, messageId, raw }));
  }

  function attachPartialMessages(error, partialMessages) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    wrapped.partialMessages = partialMessages;
    return wrapped;
  }

  async function requestSingleChain({ conversationId, anchorIndex, direction, limit, url: observedUrl }) {
    const url = buildSingleChainUrl(observedUrl);
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json, text/plain, */*",
        "agw-js-conv": "str",
        "content-type": "application/json; encoding=utf-8"
      },
      body: JSON.stringify({
        cmd: 3100,
        uplink_body: {
          pull_singe_chain_uplink_body: {
            conversation_id: conversationId,
            anchor_index: anchorIndex,
            conversation_type: 3,
            direction,
            limit,
            ext: {},
            filter: { index_list: [] },
            evaluate_ab_params: "",
            evaluate_common_params: ""
          }
        },
        sequence_id: randomId(),
        channel: 2,
        version: "1"
      })
    });

    if (!response.ok) {
      throw new Error(`接口 HTTP ${response.status}`);
    }

    return response.json();
  }

  function buildSingleChainUrl(observedUrl) {
    const url = observedUrl ? new URL(observedUrl, location.origin) : new URL("/im/chain/single", location.origin);
    const current = new URL(location.href);
    const defaults = {
      version_code: "20800",
      language: navigator.language?.startsWith("zh") ? "zh" : "zh",
      device_platform: "web",
      aid: "497858",
      real_aid: "497858",
      pkg_type: "release_version",
      region: "SG",
      sys_region: "SG",
      samantha_web: "1",
      web_platform: "browser",
      "use-olympus-account": "1",
      web_tab_id: randomId()
    };

    Object.entries(defaults).forEach(([key, value]) => {
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, current.searchParams.get(key) || value);
      }
    });

    return url.toString();
  }

  function getSingleChainBody(data) {
    return data?.downlink_body?.pull_single_chain_downlink_body
      || data?.downlink_body?.pull_singe_chain_downlink_body
      || data?.pull_single_chain_downlink_body
      || data?.pull_singe_chain_downlink_body
      || data?.data?.downlink_body?.pull_single_chain_downlink_body
      || data?.data?.downlink_body?.pull_singe_chain_downlink_body
      || data?.data?.pull_single_chain_downlink_body
      || data?.data?.pull_singe_chain_downlink_body;
  }

  function describeApiResponse(data) {
    if (!data || typeof data !== "object") return typeof data;
    const keys = Object.keys(data).slice(0, 12).join(",");
    const parts = [`keys=${keys || "none"}`];
    ["code", "status", "status_code", "message", "msg", "err_no", "err_msg"].forEach((key) => {
      if (data[key] !== undefined) parts.push(`${key}=${String(data[key]).slice(0, 120)}`);
    });
    if (data.data && typeof data.data === "object") {
      const dataKeys = Object.keys(data.data).slice(0, 8).join(",");
      parts.push(`data.keys=${dataKeys || "none"}`);
    }
    return parts.join(" ");
  }

  function parseApiMessage(raw) {
    const text = extractApiText(raw);
    return {
      role: inferApiRole(raw),
      text,
      index: getApiMessageIndex(raw),
      messageId: raw.message_id || raw.id || raw.server_message_id || "",
      raw
    };
  }

  function inferApiRole(raw) {
    if (raw.sender_type === 1 || raw.user_type === 1 || raw.from_user_id || raw.sender?.user_id) {
      return "user";
    }
    if (raw.bot_reply_message_id || raw.reply_id || raw.sender_type === 2 || raw.user_type === 2) {
      return "assistant";
    }
    if (raw.message_type === 1 && raw.content) return "user";
    return raw.content && !raw.brief ? "user" : "assistant";
  }

  function extractApiText(raw) {
    const contentObject = parseMaybeJson(raw.content);
    const contentObjObject = parseMaybeJson(raw.content_obj);
    const messageContentObject = parseMaybeJson(raw.message_content);
    const contentBlock = parseMaybeJson(raw.content_block);

    const blockText = extractContentBlockText(contentBlock || raw.content_block);
    if (blockText) return blockText;

    const candidates = [
      contentObject?.text,
      contentObject?.content,
      contentObject?.message,
      contentObjObject?.text,
      contentObjObject?.content,
      contentObjObject?.message,
      messageContentObject?.text,
      messageContentObject?.content,
      messageContentObject?.message,
      raw.content,
      raw.brief,
      raw.content_obj?.text,
      raw.content_obj?.content,
      raw.message_content,
      raw.tts_content,
      raw.text
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && !looksLikeJson(candidate) && normalizeText(candidate)) {
        return normalizeText(candidate);
      }
    }

    return "";
  }

  function getNextApiAnchor(body, pageMessages, currentAnchor) {
    const explicitAnchor = getFirstPositiveInteger(
      body.next_anchor_index,
      body.next_anchor,
      body.next_index,
      body.next_index_in_conv,
      body.min_anchor_index,
      body.min_index,
      body.min_index_in_conv,
      body.last_index,
      body.last_index_in_conv,
      body.cursor?.next_anchor_index,
      body.cursor?.anchor_index,
      body.cursor?.index_in_conv,
      body.page_info?.next_anchor_index,
      body.page_info?.min_index,
      body.page_info?.min_index_in_conv,
      body.pagination?.next_anchor_index,
      body.pagination?.min_index,
      body.pagination?.min_index_in_conv
    );

    if (explicitAnchor && explicitAnchor !== currentAnchor) {
      return { anchor: explicitAnchor, source: "body" };
    }

    const indexes = pageMessages.map(getApiMessageIndex).filter(Boolean);
    if (!indexes.length) return { anchor: 0, source: "" };

    const minIndex = Math.min(...indexes);
    if (minIndex < currentAnchor) return { anchor: minIndex, source: "message" };
    return { anchor: Math.max(1, minIndex - 1), source: "message-minus-one" };
  }

  function getFallbackApiAnchor(pageMessages, currentAnchor) {
    const indexes = pageMessages.map(getApiMessageIndex).filter(Boolean);
    if (indexes.length) {
      return Math.max(1, Math.min(...indexes) - 1);
    }

    if (currentAnchor > 1 && currentAnchor < Number.MAX_SAFE_INTEGER) {
      return Math.max(1, currentAnchor - pageMessages.length);
    }

    return 0;
  }

  function getApiMessageIndex(raw) {
    const ext = parseMaybeJson(raw.ext);
    const localInfo = parseMaybeJson(raw.local_info);
    const messageInfo = parseMaybeJson(raw.message_info);
    return getFirstPositiveInteger(
      raw.index,
      raw.index_in_conv,
      raw.message_index,
      raw.msg_index,
      raw.chain_index,
      raw.conversation_index,
      raw.item_index,
      raw.position,
      raw.seq_index,
      raw.sequence_index,
      raw.sort_index,
      raw.extra?.index,
      raw.extra?.index_in_conv,
      raw.extra?.message_index,
      raw.extra?.chain_index,
      ext?.index,
      ext?.index_in_conv,
      ext?.message_index,
      ext?.chain_index,
      localInfo?.index,
      localInfo?.index_in_conv,
      localInfo?.message_index,
      messageInfo?.index,
      messageInfo?.index_in_conv,
      messageInfo?.message_index
    );
  }

  function getApiMessageIdentity(raw) {
    return String(
      raw.message_id
        || raw.id
        || raw.server_message_id
        || `${getApiMessageIndex(raw)}:${raw.role || raw.sender_type || ""}:${raw.brief || raw.content || ""}`
    );
  }

  function getFirstPositiveInteger(...values) {
    for (const value of values) {
      const number = Number(value);
      if (Number.isFinite(number) && number > 0) return Math.floor(number);
    }
    return 0;
  }

  function parseMaybeJson(value) {
    if (!value) return value;
    if (typeof value === "object") return value;
    if (typeof value !== "string" || !looksLikeJson(value)) return null;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function looksLikeJson(value) {
    const text = String(value || "").trim();
    return (text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"));
  }

  function extractContentBlockText(blocks) {
    if (!Array.isArray(blocks) && typeof blocks !== "object") return "";
    const parts = [];

    const visit = (value) => {
      if (!value) return;
      if (typeof value === "string") {
        const text = normalizeText(value);
        if (text && !/^https?:\/\//.test(text)) parts.push(text);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value === "object") {
        [
          "text",
          "content",
          "summary",
          "title",
          "markdown",
          "code",
          "text_block",
          "markdown_block",
          "code_block",
          "quote_block",
          "paragraph"
        ].forEach((key) => visit(value[key]));
      }
    };

    visit(blocks);
    return Array.from(new Set(parts)).join("\n\n");
  }

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
      let screen = 0;

      for (let i = 0; i < limits.maxCollectScreens; i += 1) {
        checkCancelled(controller);
        screen += 1;
        const beforeCount = ordered.length;
        mergeMessageWindow(ordered, collectVisibleMessages());

        progress({
          stage: "collect",
          message: `正在收集第 ${screen} 屏`,
          count: ordered.length,
          top: Math.round(scroller.scrollTop),
          total: Math.round(scroller.scrollHeight)
        });

        const beforeTop = scroller.scrollTop;
        scroller.scrollTop = beforeTop + Math.max(360, scroller.clientHeight * 0.75);
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
      const beforeTop = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, beforeTop - Math.max(420, scroller.clientHeight * 0.9));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await waitForScrollSettle(scroller, controller);

      const noMovement = Math.abs(scroller.scrollTop - lastTop) < 3;
      const noHeightChange = Math.abs(scroller.scrollHeight - lastHeight) < 3;
      const atTop = scroller.scrollTop <= 2;

      progress({
        stage: "seek-top",
        message: `正在加载更早消息 ${i + 1}`,
        count: collectVisibleMessages().length,
        top: Math.round(scroller.scrollTop),
        total: Math.round(scroller.scrollHeight)
      });

      if ((atTop || noMovement) && noHeightChange) {
        idleSteps += 1;
      } else {
        idleSteps = 0;
      }

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
    const rows = findRows();
    const messages = [];

    rows.forEach((row, index) => {
      const message = extractMessage(row, index);
      if (message) messages.push(message);
    });

    return messages;
  }

  function findRows() {
    const selectors = [
      ".v_list_row",
      "[class*='v_list_row']",
      ".list_items > div",
      "[class*='list_items'] > div"
    ];

    for (const selector of selectors) {
      const rows = Array.from(document.querySelectorAll(selector)).filter((row) => {
        const text = normalizeText(row.innerText || row.textContent || "");
        return text && !row.querySelector("textarea,input,[contenteditable='true']");
      });
      if (rows.length) return rows;
    }

    return [];
  }

  function extractMessage(row, index) {
    const isUser = hasUserLayout(row);
    const assistantNode = findAssistantNode(row);
    const userNode = isUser ? findUserNode(row) : null;
    const role = isUser ? "user" : "assistant";
    const contentNode = userNode || assistantNode || row;
    const text = cleanMessageText(contentNode);

    if (!text || isChromeText(text)) return null;
    return { role, text, index };
  }

  function hasUserLayout(row) {
    return Array.from(row.querySelectorAll("div")).some((node) => {
      const className = ` ${String(node.className || "")} `;
      const text = normalizeText(node.innerText || node.textContent || "");
      return text && className.includes(" justify-end ");
    });
  }

  function findAssistantNode(row) {
    return row.querySelector(
      ".flow-markdown-body,[class*='flow-markdown-body'],.md-box-root,[class*='md-box-root']"
    );
  }

  function findUserNode(row) {
    const candidates = Array.from(
      row.querySelectorAll("[class*='bg-g-send-msg-bubble'],[class*='text-g-send-msg-bubble'],[class*='send-msg-bubble']")
    );

    candidates.sort((a, b) => {
      const aText = normalizeText(a.innerText || a.textContent || "");
      const bText = normalizeText(b.innerText || b.textContent || "");
      return aText.length - bText.length;
    });

    return candidates.find((node) => normalizeText(node.innerText || node.textContent || ""));
  }

  function cleanMessageText(node) {
    return normalizeText(node.innerText || node.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function isChromeText(text) {
    const blocked = new Set(["搜索…", "新对话", "聊聊新话题", "发送"]);
    return blocked.has(text);
  }

  function findScroller() {
    const candidates = Array.from(
      document.querySelectorAll(".v_list_scroller,[class*='v_list_scroller'],.scroller,[class*='scroller']")
    );

    return candidates.find(isScrollable) || findLargestScrollable(document.body);
  }

  function isScrollable(element) {
    if (!element) return false;
    return element.scrollHeight > element.clientHeight + 40;
  }

  function findLargestScrollable(root) {
    return Array.from(root.querySelectorAll("*"))
      .filter(isScrollable)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  }

  function buildPayload(messages, meta = {}) {
    return {
      source: "doubao",
      url: location.href,
      title: document.title,
      chatId: location.pathname.split("/").filter(Boolean).pop() || "",
      exportedAt: new Date().toISOString(),
      meta,
      messages: messages.map(({ role, text, messageId, raw }, index) => ({
        index: index + 1,
        role,
        text,
        ...(messageId ? { messageId } : {}),
        ...(raw ? { raw } : {})
      }))
    };
  }

  function toMarkdown(payload) {
    const lines = [
      "# 豆包对话导出",
      "",
      `- 标题：${payload.title || "豆包对话"}`,
      `- URL：${payload.url}`,
      `- 导出时间：${payload.exportedAt}`,
      "",
      "## 对话",
      ""
    ];

    for (const message of payload.messages) {
      lines.push(`### ${message.role === "user" ? "用户" : "豆包"}`, "", message.text, "");
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
      if (Math.abs(top - lastTop) < 2 && Math.abs(height - lastHeight) < 2) {
        stable += 1;
      } else {
        stable = 0;
      }
      lastTop = top;
      lastHeight = height;
      if (stable >= 2) break;
    }
  }

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
      maxCollectScreens: clampInteger(options.maxCollectScreens, 300),
      maxApiPages: clampInteger(options.maxApiPages, 1000, 1, 5000),
      apiPageSize: clampInteger(options.apiPageSize, 20, 1, 50),
      apiStartAnchor: optionalInteger(options.apiStartAnchor, 0, Number.MAX_SAFE_INTEGER)
    };
  }

  function clampInteger(value, fallback, min = 10, max = 1000) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(number)));
  }

  function optionalInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
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

  function getConversationId() {
    return getDoubaoChatInfo().id;
  }

  function getDoubaoChatIdFromPath(pathname) {
    return getDoubaoChatInfoFromPath(pathname).id;
  }

  function getDoubaoChatInfo() {
    return getDoubaoChatInfoFromPath(location.pathname);
  }

  function getDoubaoChatInfoFromPath(pathname) {
    const path = String(pathname || "");
    const botMatch = path.match(/^\/chat\/bot\/chat\/(\d+)\/?$/);
    if (botMatch) return { id: botMatch[1], type: "bot-chat" };

    const chatMatch = path.match(/^\/chat\/(\d+)\/?$/);
    if (chatMatch) return { id: chatMatch[1], type: "chat" };

    return { id: "", type: "" };
  }

  function getInitialApiPage(limits, chatInfo) {
    if (limits.apiStartAnchor !== undefined) {
      return {
        conversationId: chatInfo.id,
        anchorIndex: limits.apiStartAnchor,
        direction: limits.apiStartAnchor > 0 ? 1 : 3,
        source: "manual"
      };
    }

    if (chatInfo.type === "chat") {
      return {
        conversationId: chatInfo.id,
        anchorIndex: Number.MAX_SAFE_INTEGER,
        direction: 1,
        source: "chat-default"
      };
    }

    return {
      conversationId: chatInfo.id,
      anchorIndex: 0,
      direction: 3,
      source: "bot-chat-default"
    };
  }

  async function resolveInitialApiPage(chatInfo, limits, progress, controller) {
    if (!observedSingleChains.length) {
      progress({ stage: "api", message: "等待页面接口参数", count: 0 });
      await waitForObservedSingleChain(controller, 1500);
    }

    const candidates = buildInitialApiCandidates(chatInfo, limits);
    const errors = [];

    for (const candidate of candidates) {
      checkCancelled(controller);
      if (!candidate.conversationId) continue;
      progress({
        stage: "api",
        message: `探测接口 ${candidate.source}`,
        count: 0
      });

      try {
        const data = await requestSingleChain({
          conversationId: candidate.conversationId,
          anchorIndex: candidate.anchorIndex,
          direction: candidate.direction,
          limit: Math.min(limits.apiPageSize, 20),
          url: candidate.url
        });
        const body = getSingleChainBody(data);
        const pageMessages = Array.isArray(body?.messages) ? body.messages : [];
        if (pageMessages.length) {
          return {
            ...candidate,
            firstPageData: data
          };
        }
        errors.push(`${candidate.source}: ${body ? "empty" : describeApiResponse(data)}`);
      } catch (error) {
        errors.push(`${candidate.source}: ${error.message || error}`);
      }
    }

    throw new Error(`接口探测失败：${errors.join("；") || "没有候选参数"}`);
  }

  async function waitForObservedSingleChain(controller, timeoutMs) {
    const startedAt = Date.now();
    while (!observedSingleChains.length && Date.now() - startedAt < timeoutMs) {
      checkCancelled(controller);
      await wait(100);
    }
  }

  function buildInitialApiCandidates(chatInfo, limits) {
    const ids = getConversationIdCandidates(chatInfo);
    const anchors = getAnchorCandidates(chatInfo);
    const candidates = [];
    const add = (conversationId, anchorIndex, direction, source, url = "") => {
      const key = `${conversationId}:${anchorIndex}:${direction}:${url}`;
      if (!conversationId || candidates.some((item) => item.key === key)) return;
      candidates.push({ key, conversationId, anchorIndex, direction, source, url });
    };

    getObservedChainCandidates().forEach((chain, index) => {
      add(
        chain.conversationId,
        Number.isFinite(chain.anchorIndex) ? chain.anchorIndex : Number.MAX_SAFE_INTEGER,
        Number.isFinite(chain.direction) ? chain.direction : 1,
        index ? "observed-chain-candidate" : "observed-chain",
        chain.url
      );
    });

    if (limits.apiStartAnchor !== undefined) {
      ids.forEach((id, index) => {
        add(id, limits.apiStartAnchor, limits.apiStartAnchor > 0 ? 1 : 3, index ? "manual-page-candidate" : "manual");
      });
      return candidates;
    }

    if (chatInfo.type === "chat") {
      ids.forEach((id, index) => {
        add(id, Number.MAX_SAFE_INTEGER, 1, index ? "chat-page-candidate" : "chat-default");
      });
      ids.forEach((id, index) => {
        add(id, 0, 3, index ? "chat-zero-candidate" : "chat-zero");
      });
      return candidates;
    }

    anchors.forEach((anchor, anchorIndex) => {
      ids.forEach((id, index) => {
        add(id, anchor, 1, index || anchorIndex ? "bot-anchor-candidate" : "bot-anchor");
      });
    });
    ids.forEach((id, index) => {
      add(id, Number.MAX_SAFE_INTEGER, 1, index ? "bot-max-candidate" : "bot-max");
    });
    ids.forEach((id, index) => {
      add(id, 0, 3, index ? "bot-page-candidate" : "bot-chat-default");
    });
    return candidates;
  }

  function getConversationIdCandidates(chatInfo) {
    const ids = new Set();
    if (chatInfo.id) ids.add(chatInfo.id);

    collectConversationIdsFromText(document.documentElement?.innerHTML || "").forEach((id) => ids.add(id));
    collectConversationIdsFromText(document.body?.innerText || "").forEach((id) => ids.add(id));
    collectConversationIdsFromStorage(localStorage).forEach((id) => ids.add(id));
    collectConversationIdsFromStorage(sessionStorage).forEach((id) => ids.add(id));

    return Array.from(ids).slice(0, 12);
  }

  function getObservedChainCandidates() {
    return observedSingleChains
      .filter((chain) => chain?.conversationId)
      .filter((chain) => !chain.response || chain.response.messageCount > 0)
      .slice(0, 8);
  }

  function getAnchorCandidates(chatInfo) {
    const anchors = new Set();
    collectAnchorsFromText(document.documentElement?.innerHTML || "").forEach((anchor) => anchors.add(anchor));
    collectAnchorsFromText(document.body?.innerText || "").forEach((anchor) => anchors.add(anchor));
    collectAnchorsFromStorage(localStorage).forEach((anchor) => anchors.add(anchor));
    collectAnchorsFromStorage(sessionStorage).forEach((anchor) => anchors.add(anchor));

    if (!anchors.size && chatInfo.type === "bot-chat") anchors.add(Number.MAX_SAFE_INTEGER);
    return Array.from(anchors)
      .filter((anchor) => Number.isFinite(anchor) && anchor > 0)
      .sort((a, b) => a - b)
      .slice(0, 12);
  }

  function collectConversationIdsFromStorage(storage) {
    const ids = new Set();
    if (!storage) return [];

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        collectConversationIdsFromText(`${key}\n${value}`).forEach((id) => ids.add(id));
        if (ids.size >= 12) break;
      }
    } catch (_error) {}

    return Array.from(ids);
  }

  function collectAnchorsFromStorage(storage) {
    const anchors = new Set();
    if (!storage) return [];

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        collectAnchorsFromText(`${key}\n${value}`).forEach((anchor) => anchors.add(anchor));
        if (anchors.size >= 12) break;
      }
    } catch (_error) {}

    return Array.from(anchors);
  }

  function collectConversationIdsFromText(text) {
    const ids = new Set();
    const source = String(text || "");
    const patterns = [
      /"conversation_id"\s*:\s*"(\d{8,})"/g,
      /\\"conversation_id\\"\s*:\s*\\"(\d{8,})\\"/g,
      /conversation_id["'=: ]+(\d{8,})/g,
      /"conversationId"\s*:\s*"(\d{8,})"/g,
      /\\"conversationId\\"\s*:\s*\\"(\d{8,})\\"/g,
      /conversationId["'=: ]+(\d{8,})/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        ids.add(match[1]);
        if (ids.size >= 12) return Array.from(ids);
      }
    }

    return Array.from(ids);
  }

  function collectAnchorsFromText(text) {
    const anchors = new Set();
    const source = String(text || "");
    const patterns = [
      /"anchor_index"\s*:\s*(\d+)/g,
      /\\"anchor_index\\"\s*:\s*(\d+)/g,
      /"index_in_conv"\s*:\s*"?(\\?\d+)"?/g,
      /\\"index_in_conv\\"\s*:\s*\\"(\d+)\\"/g,
      /"message_index"\s*:\s*"?(\\?\d+)"?/g,
      /\\"message_index\\"\s*:\s*\\"(\d+)\\"/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const value = Number(String(match[1]).replace(/\\/g, ""));
        if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) {
          anchors.add(Math.floor(value));
        }
        if (anchors.size >= 12) return Array.from(anchors);
      }
    }

    return Array.from(anchors);
  }

  function randomId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
