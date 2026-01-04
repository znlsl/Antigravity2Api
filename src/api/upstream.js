const path = require("path");

const httpClient = require("../auth/httpClient");

class UpstreamClient {
  constructor(authManager, options = {}) {
    this.auth = authManager;
    this.logger = options.logger || null;
  }

  // 基础日志方法（兼容旧 API）
  log(title, data) {
    if (this.logger) return this.logger(title, data);
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
    }
  }

  // 上游调用日志
  logUpstream(action, options = {}) {
    if (this.logger && typeof this.logger.logUpstream === "function") {
      return this.logger.logUpstream(action, options);
    }
    // 回退到基础日志
    const { method, account, model, group, attempt, maxAttempts, status, duration, error } = options;
    const attemptStr = attempt && maxAttempts ? `[${attempt}/${maxAttempts}]` : "";
    const message = `${action} ${attemptStr} [${group || ""}] @${account || "unknown"} ${model || ""}`;
    this.log("upstream", { message, status, duration, error });
  }

  // 重试日志
  logRetry(reason, options = {}) {
    if (this.logger && typeof this.logger.logRetry === "function") {
      return this.logger.logRetry(reason, options);
    }
    // 回退到基础日志
    const { attempt, maxAttempts, delayMs, account, error, nextAction } = options;
    this.log("retry", { reason, attempt, maxAttempts, delayMs, account, error, nextAction });
  }

  // 配额日志
  logQuota(event, options = {}) {
    if (this.logger && typeof this.logger.logQuota === "function") {
      return this.logger.logQuota(event, options);
    }
    this.log("quota", { event, ...options });
  }

  // 错误日志
  logError(message, error, options = {}) {
    if (this.logger && typeof this.logger.logError === "function") {
      return this.logger.logError(message, error, options);
    }
    this.log("error", { message, error: error?.message || error, ...options });
  }

  getMaxAttempts() {
    const n = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
    return Math.max(1, n || 0);
  }

  getQuotaGroupFromModel(model) {
    const m = String(model || "").toLowerCase();
    if (m.includes("claude")) return "claude";
    if (m.includes("gemini")) return "gemini";
    return "gemini";
  }

  parseDurationMs(durationStr) {
    if (!durationStr) return null;
    const str = String(durationStr).trim();
    if (!str) return null;

    let totalMs = 0;
    let matched = false;
    const re = /([\d.]+)\s*(ms|s|m|h)/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      matched = true;
      const value = parseFloat(m[1]);
      if (!Number.isFinite(value)) continue;
      const unit = m[2];
      if (unit === "ms") totalMs += value;
      else if (unit === "s") totalMs += value * 1000;
      else if (unit === "m") totalMs += value * 60 * 1000;
      else if (unit === "h") totalMs += value * 60 * 60 * 1000;
    }
    if (!matched) return null;
    return Math.round(totalMs);
  }

  parseRetryDelayMs(errText) {
    try {
      const errObj = JSON.parse(errText);
      const details = errObj.error?.details || [];

      // RetryInfo.retryDelay like "1.203608125s"
      const retryInfo = details.find((d) => d["@type"]?.includes("RetryInfo"));
      if (retryInfo?.retryDelay) {
        const ms = this.parseDurationMs(retryInfo.retryDelay);
        if (ms != null) return ms;
      }

      // quotaResetDelay like "331.167174ms" or "1h16m0.667923083s"
      const metaDelay = details.find((d) => d.metadata?.quotaResetDelay)?.metadata?.quotaResetDelay;
      if (metaDelay) {
        const ms = this.parseDurationMs(metaDelay);
        if (ms != null) return ms;
      }
    } catch (_) {}
    return null;
  }

  parseErrorDetails(errText) {
    try {
      const errObj = JSON.parse(errText);
      return {
        code: errObj.error?.code,
        message: errObj.error?.message,
        status: errObj.error?.status,
        details: errObj.error?.details,
      };
    } catch (_) {
      return { message: errText };
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * v1internal call with 429 retry + per-model quota group rotation.
   * @param {string} method - v1internal method (e.g. "generateContent")
   * @param {object} options
   * @param {string} [options.group] - "claude" | "gemini" (defaults to inferred from model)
   * @param {string} [options.model] - Used to infer group when group is not provided
   * @param {string} [options.queryString]
   * @param {(projectId: string) => object} options.buildBody
   * @param {object} [options.headers]
   * @returns {Promise<Response>}
   */
  async callV1Internal(method, options = {}) {
    const buildBody = options.buildBody;
    if (typeof buildBody !== "function") {
      throw new Error("UpstreamClient.callV1Internal requires options.buildBody(projectId)");
    }

    const quotaGroup = this.getQuotaGroupFromModel(options.group || options.model);
    const queryString = options.queryString || "";
    const headers = options.headers && typeof options.headers === "object" ? options.headers : {};

    let lastResponse = null;
    const maxAttempts = this.getMaxAttempts();

    this.logUpstream(`开始调用 v1internal:${method}`, {
      method,
      group: quotaGroup,
      model: options.model,
      maxAttempts,
    });

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
      const attemptNum = attempts + 1;
      let creds;
      
      try {
        creds = await this.auth.getCredentials(quotaGroup);
      } catch (e) {
        this.logError(`获取凭证失败 [${quotaGroup}]`, e, { attempt: attemptNum, maxAttempts });
        throw e;
      }

      const accountName = creds?.account?.filePath ? path.basename(creds.account.filePath) : "unknown-account";
      const requestBody = buildBody(creds.projectId);
      const startTime = Date.now();

      this.logUpstream(`发送请求`, {
        method,
        account: accountName,
        group: quotaGroup,
        attempt: attemptNum,
        maxAttempts,
        model: options.model,
      });

      let response;
      try {
        response = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
          queryString,
          headers,
          limiter: this.auth.apiLimiter,
        });
      } catch (netErr) {
        const duration = Date.now() - startTime;
        this.logError(`网络错误`, netErr, {
          context: {
            method: `v1internal:${method}`,
            group: quotaGroup,
            account: accountName,
            attempt: attemptNum,
            maxAttempts,
            duration,
          },
        });

        // Network/transport error: rotate and try next account.
        lastResponse = null;
        
        this.logRetry("网络错误，轮换账户", {
          attempt: attemptNum,
          maxAttempts,
          account: accountName,
          error: netErr.message || netErr,
          nextAction: "轮换到下一个账户",
        });

        if (this.auth && typeof this.auth.rotateAccount === "function") {
          this.auth.rotateAccount(quotaGroup);
        }
        continue;
      }

      const duration = Date.now() - startTime;

      if (response.ok) {
        this.logUpstream(`请求成功`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: attemptNum,
          maxAttempts,
          status: response.status,
          duration,
        });
        return response;
      }

      // Non-429 4xx: do not retry/rotate, pass through as-is.
      if (response.status !== 429) {
        let errorText = "";
        try {
          errorText = await response.clone().text();
        } catch (_) {}

        const errorDetails = this.parseErrorDetails(errorText);
        
        this.logUpstream(`请求失败 (${response.status})`, {
          method,
          account: accountName,
          group: quotaGroup,
          attempt: attemptNum,
          maxAttempts,
          status: response.status,
          duration,
          error: errorDetails,
        });

        return response;
      }

      lastResponse = response;

      // 429: decide short-wait retry vs rotate.
      let errorText = "";
      try {
        errorText = await response.clone().text();
      } catch (_) {}

      const errorDetails = this.parseErrorDetails(errorText);
      const retryMs = this.parseRetryDelayMs(errorText);

      this.logQuota(`收到 429 限流响应`, {
        account: accountName,
        group: quotaGroup,
        resetDelay: retryMs,
      });

      this.log("error", `🚫 Google API 429 错误详情`, errorDetails);

      if (retryMs != null && retryMs <= 5000) {
        const delay = Math.max(0, retryMs + 200);
        
        this.logRetry("短时间限流，等待重试", {
          attempt: attemptNum,
          maxAttempts,
          delayMs: delay,
          account: accountName,
          nextAction: "同账户重试",
        });

        await this.sleep(delay);

        // Retry once on the same account with the same request body.
        const retryStartTime = Date.now();
        let retryResp;
        try {
          retryResp = await httpClient.callV1Internal(method, creds.accessToken, requestBody, {
            queryString,
            headers,
            limiter: this.auth.apiLimiter,
          });
        } catch (netErr2) {
          const retryDuration = Date.now() - retryStartTime;
          this.logError(`重试时网络错误`, netErr2, {
            context: {
              method: `v1internal:${method}`,
              group: quotaGroup,
              account: accountName,
              attempt: attemptNum,
              duration: retryDuration,
            },
          });

          this.logRetry("重试失败，轮换账户", {
            attempt: attemptNum,
            maxAttempts,
            account: accountName,
            error: netErr2.message || netErr2,
            nextAction: "轮换到下一个账户",
          });

          if (this.auth && typeof this.auth.rotateAccount === "function") {
            this.auth.rotateAccount(quotaGroup);
          }
          continue;
        }

        const retryDuration = Date.now() - retryStartTime;

        if (retryResp.ok) {
          this.logUpstream(`重试成功`, {
            method,
            account: accountName,
            group: quotaGroup,
            attempt: attemptNum,
            maxAttempts,
            status: retryResp.status,
            duration: retryDuration,
          });
          return retryResp;
        }
        
        if (retryResp.status !== 429) {
          this.logUpstream(`重试返回非 429 错误`, {
            method,
            account: accountName,
            group: quotaGroup,
            attempt: attemptNum,
            maxAttempts,
            status: retryResp.status,
            duration: retryDuration,
          });
          return retryResp;
        }

        lastResponse = retryResp;
        
        this.logQuota(`重试后仍然 429`, {
          account: accountName,
          group: quotaGroup,
        });
      }

      // Rotate to next account (either delay>5s, no delay, or retry still 429).
      this.logRetry("需要轮换账户", {
        attempt: attemptNum,
        maxAttempts,
        delayMs: retryMs,
        account: accountName,
        nextAction: retryMs && retryMs > 5000 ? `延迟过长 (${retryMs}ms)，轮换账户` : "轮换到下一个账户",
      });

      if (this.auth && typeof this.auth.rotateAccount === "function") {
        this.auth.rotateAccount(quotaGroup);
      }
    }

    // Exhausted: return the last upstream 429 response as-is (status/headers/body passthrough).
    if (lastResponse) {
      this.logError(`所有账户都已耗尽`, null, {
        context: {
          method: `v1internal:${method}`,
          group: quotaGroup,
          totalAttempts: maxAttempts,
        },
      });
      return lastResponse;
    }

    const error = new Error(`Upstream call exhausted without a response (v1internal:${method})`);
    error.status = 500;
    this.logError(`上游调用失败`, error, {
      context: { method: `v1internal:${method}`, group: quotaGroup },
    });
    throw error;
  }

  async fetchAvailableModels() {
    const accessToken = await this.auth.getCurrentAccessToken();
    this.log("info", "📋 获取可用模型列表");
    return httpClient.fetchAvailableModels(accessToken, this.auth.apiLimiter);
  }

  /**
   * v1internal:countTokens with 429 rotation policy (final 429 passthrough).
   * @param {object} body - Raw countTokens request body (typically { request: { model, contents } })
   * @param {object} [options]
   * @param {string} [options.group]
   * @param {string} [options.model]
   * @returns {Promise<Response>}
   */
  async countTokens(body, options = {}) {
    const inferredModel = options.model || body?.request?.model || body?.model;
    this.log("info", `🔢 计算 Token 数量 (${inferredModel || "unknown model"})`);
    return this.callV1Internal("countTokens", {
      group: options.group,
      model: inferredModel,
      buildBody: () => body || {},
    });
  }
}

module.exports = UpstreamClient;
