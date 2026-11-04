(() => {
  if (window.__doubaoExportPageHookInstalled) return;
  window.__doubaoExportPageHookInstalled = true;

  const MESSAGE_TYPE = "DOUBAO_EXPORT_CHAIN_OBSERVED";

  function isSingleChainUrl(value) {
    try {
      return new URL(String(value), location.href).pathname === "/im/chain/single";
    } catch (_error) {
      return false;
    }
  }

  function readRequest(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const body = init?.body;
    return { url, body };
  }

  function parseBody(body) {
    if (!body || typeof body !== "string") return null;
    try {
      return JSON.parse(body);
    } catch (_error) {
      return null;
    }
  }

  function extractRequestInfo(url, requestBody) {
    const body = parseBody(requestBody);
    const uplink = body?.uplink_body?.pull_singe_chain_uplink_body
      || body?.uplink_body?.pull_single_chain_uplink_body;
    if (!uplink?.conversation_id) return null;

    return {
      url: String(url || ""),
      conversationId: String(uplink.conversation_id),
      anchorIndex: Number(uplink.anchor_index),
      direction: Number(uplink.direction),
      limit: Number(uplink.limit),
      observedAt: Date.now()
    };
  }

  function extractResponseInfo(data) {
    const downlink = data?.downlink_body?.pull_singe_chain_downlink_body
      || data?.downlink_body?.pull_single_chain_downlink_body
      || data?.pull_singe_chain_downlink_body
      || data?.pull_single_chain_downlink_body;
    const messages = Array.isArray(downlink?.messages) ? downlink.messages : [];
    return {
      hasMore: Boolean(downlink?.has_more),
      messageCount: messages.length,
      indexes: messages
        .map((message) => Number(message.index_in_conv || message.index || message.message_index))
        .filter(Number.isFinite)
        .slice(0, 20)
    };
  }

  function publish(detail) {
    window.postMessage({ type: MESSAGE_TYPE, detail }, location.origin);
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(input, init) {
      const request = readRequest(input, init);
      const requestInfo = isSingleChainUrl(request.url) ? extractRequestInfo(request.url, request.body) : null;
      const response = await originalFetch.apply(this, arguments);

      if (requestInfo) {
        response.clone().json()
          .then((data) => publish({ ...requestInfo, response: extractResponseInfo(data) }))
          .catch(() => publish(requestInfo));
      }

      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === "function") {
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function patchedOpen(method, url) {
      this.__doubaoExportUrl = url;
      return originalOpen.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function patchedSend(body) {
      const requestInfo = isSingleChainUrl(this.__doubaoExportUrl)
        ? extractRequestInfo(this.__doubaoExportUrl, body)
        : null;

      if (requestInfo) {
        this.addEventListener("load", () => {
          try {
            publish({ ...requestInfo, response: extractResponseInfo(JSON.parse(this.responseText)) });
          } catch (_error) {
            publish(requestInfo);
          }
        });
      }

      return originalSend.apply(this, arguments);
    };
  }
})();
