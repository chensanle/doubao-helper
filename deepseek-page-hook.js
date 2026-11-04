(() => {
  if (window.__deepseekExportPageHookInstalled) return;
  window.__deepseekExportPageHookInstalled = true;

  const OBSERVED_TYPE = "DEEPSEEK_EXPORT_HISTORY_OBSERVED";
  const FETCH_REQUEST_TYPE = "DEEPSEEK_EXPORT_FETCH_REQUEST";
  const FETCH_RESULT_TYPE = "DEEPSEEK_EXPORT_FETCH_RESULT";
  const HISTORY_PATH = "/api/v0/chat/history_messages";
  // 只记录重放历史接口需要的请求头，token 留在页面里，不会传给 content script。
  const HEADER_WHITELIST = new Set([
    "authorization",
    "x-app-version",
    "x-client-platform",
    "x-client-version",
    "x-client-locale",
    "x-client-timezone-offset"
  ]);

  const observedHeaders = {};
  const observedHistory = new Map();
  let observedHistoryUrl = "";

  function toUrl(value) {
    try {
      return new URL(String(value), location.href);
    } catch (_error) {
      return null;
    }
  }

  function isApiUrl(url) {
    return Boolean(url && url.origin === location.origin && url.pathname.startsWith("/api/"));
  }

  function isHistoryUrl(url) {
    return Boolean(url && url.origin === location.origin && url.pathname === HISTORY_PATH);
  }

  function rememberHeader(name, value) {
    const key = String(name || "").toLowerCase();
    if (!HEADER_WHITELIST.has(key) || value === undefined || value === null || value === "") return;
    observedHeaders[key] = String(value);
  }

  function rememberHeaders(headers) {
    if (!headers) return;
    try {
      if (typeof Headers === "function" && headers instanceof Headers) {
        headers.forEach((value, name) => rememberHeader(name, value));
      } else if (Array.isArray(headers)) {
        headers.forEach(([name, value]) => rememberHeader(name, value));
      } else if (typeof headers === "object") {
        Object.entries(headers).forEach(([name, value]) => rememberHeader(name, value));
      }
    } catch (_error) {}
  }

  function rememberHistory(url, data) {
    const sessionId = url.searchParams.get("chat_session_id");
    if (!sessionId) return;
    observedHistoryUrl = url.toString();
    observedHistory.set(sessionId, { data, observedAt: Date.now() });
    if (observedHistory.size > 10) observedHistory.delete(observedHistory.keys().next().value);

    const messages = data?.data?.biz_data?.chat_messages;
    window.postMessage({
      type: OBSERVED_TYPE,
      detail: {
        sessionId,
        url: observedHistoryUrl,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        observedAt: Date.now()
      }
    }, location.origin);
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const url = toUrl(typeof input === "string" || input instanceof URL ? input : input?.url);
      if (isApiUrl(url)) {
        if (input && typeof input === "object" && "headers" in input) rememberHeaders(input.headers);
        rememberHeaders(init?.headers);
      }

      const response = await originalFetch.apply(this, arguments);

      if (isHistoryUrl(url)) {
        response.clone().json()
          .then((data) => rememberHistory(url, data))
          .catch(() => {});
      }

      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSetRequestHeader = OriginalXHR.prototype.setRequestHeader;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url) {
      this.__deepseekExportUrl = toUrl(url);
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      if (isApiUrl(this.__deepseekExportUrl)) rememberHeader(name, value);
      return originalSetRequestHeader.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function patchedSend() {
      const url = this.__deepseekExportUrl;
      if (isHistoryUrl(url)) {
        this.addEventListener("load", () => {
          try {
            rememberHistory(url, JSON.parse(this.responseText));
          } catch (_error) {}
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  function readStoredToken() {
    try {
      const raw = localStorage.getItem("userToken");
      if (!raw) return "";
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? parsed : String(parsed?.value || "");
    } catch (_error) {
      return "";
    }
  }

  function buildHistoryUrl(sessionId) {
    const url = (observedHistoryUrl && toUrl(observedHistoryUrl)) || new URL(HISTORY_PATH, location.origin);
    url.searchParams.set("chat_session_id", sessionId);
    return url.toString();
  }

  function buildHeaders() {
    const headers = { accept: "*/*", ...observedHeaders };
    if (!headers.authorization) {
      const token = readStoredToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    if (!headers["x-client-platform"]) headers["x-client-platform"] = "web";
    return headers;
  }

  async function fetchHistory(sessionId) {
    const headerSource = observedHeaders.authorization ? "observed-headers" : "stored-token";
    try {
      const response = await originalFetch.call(window, buildHistoryUrl(sessionId), {
        method: "GET",
        credentials: "include",
        headers: buildHeaders()
      });
      if (!response.ok) throw new Error(`接口 HTTP ${response.status}`);
      return { ok: true, data: await response.json(), source: headerSource };
    } catch (error) {
      const cached = observedHistory.get(sessionId);
      if (cached) {
        return {
          ok: true,
          data: cached.data,
          source: "observed-response",
          fetchError: error.message || String(error)
        };
      }
      return { ok: false, error: error.message || String(error), source: headerSource };
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type !== FETCH_REQUEST_TYPE) return;
    const { requestId, sessionId } = event.data;
    if (!requestId || !sessionId) return;

    fetchHistory(String(sessionId)).then((result) => {
      window.postMessage({ type: FETCH_RESULT_TYPE, requestId, ...result }, location.origin);
    });
  });
})();
