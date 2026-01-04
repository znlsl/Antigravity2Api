const { transformClaudeRequestIn, transformClaudeResponseOut, mapClaudeModelToGemini } = require("../transform/claude");
const { getMcpSwitchModel } = require("../mcp/mcpSwitchFlag");
const {
  prepareMcpContext,
  bufferForMcpSwitchAndMaybeRetry,
  updateSessionAfterResponse,
} = require("../mcp/claudeApiMcp");

function hasWebSearchTool(claudeReq) {
  return Array.isArray(claudeReq?.tools) && claudeReq.tools.some((tool) => tool?.name === "web_search");
}

function inferFinalModelForQuota(claudeReq) {
  if (hasWebSearchTool(claudeReq)) return "gemini-2.5-flash";
  return mapClaudeModelToGemini(claudeReq?.model);
}

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  delete out["content-encoding"];
  delete out["content-length"];
  return out;
}

class ClaudeApi {
  constructor(options = {}) {
    this.upstream = options.upstreamClient;
    this.logger = options.logger || null;
    this.debugRequestResponse = !!options.debug;
    this.sessionMcpState = new Map(); // sessionId -> { lastFamily, mcpStartIndex, foldedSegments: [] }
  }

  log(title, data) {
    if (this.logger) {
      if (typeof this.logger.log === "function") {
        return this.logger.log(title, data);
      }
      return this.logger(title, data);
    }
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
    }
  }

  logDebug(title, data) {
    if (!this.debugRequestResponse) return;
    this.log("debug", `${title}`, data);
  }

  logStream(event, options = {}) {
    if (this.logger && typeof this.logger.logStream === "function") {
      return this.logger.logStream(event, options);
    }
    this.log("stream", { event, ...options });
  }

  async logStreamContent(stream, label) {
    if (!stream) return stream;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let bufferStr = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = decoder.decode(value, { stream: true });
        bufferStr += chunkStr;
      }
      if (bufferStr) {
        this.log(`${label}`, bufferStr);
      }
    } catch (err) {
      this.log("warn", `Raw stream log failed for ${label}: ${err.message || err}`);
    }
    return stream;
  }

  async handleListModels() {
    try {
      const remoteModelsMap = await this.upstream.fetchAvailableModels();
      const now = Math.floor(Date.now() / 1000);
      const models = [];

      for (const id of Object.keys(remoteModelsMap)) {
        if (id && id.toLowerCase().includes("claude")) {
          models.push({ id, object: "model", created: now, owned_by: "anthropic" });
        }
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { object: "list", data: models },
      };
    } catch (e) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: e.message || String(e) } },
      };
    }
  }

  async handleCountTokens(requestData) {
    try {
      if (!requestData) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: "Empty request body" } },
        };
      }

      this.log("Claude CountTokens Request", requestData);

      // projectId is not required for countTokens, but transform reuses Claude->v1internal mapping to build contents/model.
      const { body: finalBody } = transformClaudeRequestIn(requestData, "");

      const countTokensBody = {
        request: {
          model: finalBody.model,
          contents: finalBody.request.contents || [],
        },
      };
      this.log("CountTokens Request Body", countTokensBody);

      const countTokensResp = await this.upstream.countTokens(countTokensBody, { model: finalBody.model });
      if (!countTokensResp.ok) {
        return {
          status: countTokensResp.status,
          headers: headersToObject(countTokensResp.headers),
          body: countTokensResp.body,
        };
      }

      const data = await countTokensResp.json();
      this.log("CountTokens Response", data);

      let totalTokens = data.totalTokens || 0;

      // 本地估算 Tools Token (API 不计算 Tools，参考现有实现)
      if (finalBody.request && finalBody.request.tools) {
        try {
          const toolsStr = JSON.stringify(finalBody.request.tools);
          const toolsTokenCount = Math.floor(toolsStr.length / 4);
          this.log("info", `本地估算 Tools Token: ${toolsTokenCount}`);
          totalTokens += toolsTokenCount;
        } catch (e) {
          this.log("error", `Tools token estimation failed: ${e.message || e}`);
        }
      }

      const result = { input_tokens: totalTokens };
      this.log("CountTokens Result", result);

      return { status: 200, headers: { "Content-Type": "application/json" }, body: result };
    } catch (error) {
      this.log("Error processing CountTokens", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { type: "internal_error", message: error.message } },
      };
    }
  }

  async handleMessages(requestData) {
    try {
      if (!requestData) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: "Empty request body" } },
        };
      }

      this.logDebug("Claude Payload Request", requestData);

      const method = requestData.stream ? "streamGenerateContent" : "generateContent";
      const queryString = requestData.stream ? "?alt=sse" : "";

      const mcpModel = getMcpSwitchModel();
      let baseModel = requestData.model;
      let modelForQuota = inferFinalModelForQuota(requestData);
      let upstreamRequestForTransform = requestData;
      let shouldBufferForSwitch = false;
      let transformOptions = undefined;
      let sessionState = null;

      if (mcpModel) {
        ({ baseModel, modelForQuota, upstreamRequestForTransform, shouldBufferForSwitch, transformOptions, sessionState } =
          prepareMcpContext({
            requestData,
            sessionMcpState: this.sessionMcpState,
            mcpModel,
            inferFinalModelForQuota,
          }));
      }

      let loggedTransformed = false;
      const response = await this.upstream.callV1Internal(method, {
        model: modelForQuota,
        queryString,
        buildBody: (projectId) => {
          const { body: googleBody } = transformClaudeRequestIn(upstreamRequestForTransform, projectId, transformOptions);
          if (!loggedTransformed) {
            this.logDebug("Gemini Payload Request (Transformed)", googleBody);
            loggedTransformed = true;
          }
          return googleBody;
        },
      });

      if (!response.ok) {
        const headers = headersToObject(response.headers);
        let body = response.body;

        // In debug mode, also log upstream non-2xx bodies (400/401/403/etc).
        // We must not consume the body we return to the client, so prefer tee().
        if (this.debugRequestResponse && response.body) {
          try {
            if (typeof response.body.tee === "function") {
              const [logBranch, processBranch] = response.body.tee();
              this.logStreamContent(logBranch, `Upstream Error Raw (Stream, HTTP ${response.status})`);
              body = processBranch;
            } else {
              const errorText = await response.clone().text().catch(() => "");
              if (errorText) this.log(`Upstream Error Body (HTTP ${response.status})`, errorText);
            }
          } catch (e) {
            this.log("warn", `Failed to log upstream error body: ${e.message || e}`);
          }
        }

        return {
          status: response.status,
          headers,
          body,
        };
      }

      // Log Gemini response raw stream
      let responseForTransform = response;
      if (this.debugRequestResponse && response.body) {
        try {
          const [logBranch, processBranch] = response.body.tee();
          this.logStreamContent(logBranch, "Gemini Response Raw (Stream)");
          responseForTransform = new Response(processBranch, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (e) {
          this.log("Error teeing stream for logging", e.message || e);
        }
      }

      const convertedResponse = await transformClaudeResponseOut(
        responseForTransform,
        mcpModel ? { overrideModel: baseModel } : undefined,
      );

      let finalResponseBody = convertedResponse.body;

      if (mcpModel) {
        const bufferedResult = await bufferForMcpSwitchAndMaybeRetry({
          upstream: this.upstream,
          method,
          queryString,
          requestData,
          baseModel,
          mcpModel,
          convertedResponse,
          shouldBufferForSwitch,
          debugRequestResponse: this.debugRequestResponse,
          log: (title, data) => this.log(title, data),
          logDebug: (title, data) => this.logDebug(title, data),
          logStreamContent: (stream, label) => this.logStreamContent(stream, label),
          sessionState,
        });
        if (bufferedResult?.apiResponse) return bufferedResult.apiResponse;
        if (bufferedResult?.finalResponseBody) {
          finalResponseBody = bufferedResult.finalResponseBody;
        } else if (this.debugRequestResponse && convertedResponse.body) {
          try {
            const [logBranch, processBranch] = convertedResponse.body.tee();
            this.logStreamContent(logBranch, "Claude Response Payload (Transformed Stream)");
            finalResponseBody = processBranch;
          } catch (e) {
            this.log("Error teeing converted stream for logging", e.message || e);
          }
        }

        updateSessionAfterResponse({ sessionState, requestData, baseModel, modelForQuota, mcpModel });
      } else if (this.debugRequestResponse && convertedResponse.body) {
        try {
          const [logBranch, processBranch] = convertedResponse.body.tee();
          this.logStreamContent(logBranch, "Claude Response Payload (Transformed Stream)");
          finalResponseBody = processBranch;
        } catch (e) {
          this.log("Error teeing converted stream for logging", e.message || e);
        }
      }

      return {
        status: convertedResponse.status,
        headers: {
          "Content-Type": convertedResponse.headers.get("Content-Type") || "application/json",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: finalResponseBody,
      };
    } catch (error) {
      this.log("Error processing Claude request", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { type: "internal_error", message: error.message } },
      };
    }
  }
}

module.exports = ClaudeApi;
