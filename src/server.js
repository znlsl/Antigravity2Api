// Proxy must be initialized before any fetch
require("./utils/proxy");

const http = require("http");
const path = require("path");

const { getConfig } = require("./utils/config");
const { createLogger, Colors, Box } = require("./utils/logger");
const { extractApiKey, parseJsonBody } = require("./utils/http");

const { AuthManager, OAuthFlow } = require("./auth");
const { ClaudeApi, GeminiApi, UpstreamClient } = require("./api");
const { handleAdminRoute, handleOAuthCallbackRoute } = require("./admin/routes");
const { handleUiRoute } = require("./ui/routes");

const config = getConfig();
const logger = createLogger({ logRetentionDays: config.log?.retention_days });
const debugRequestResponse = !!config.debug;

// 兼容旧的日志 API
const log = (level, data) => {
  if (typeof level === "string" && data !== undefined) {
    logger.log(level, data);
  } else {
    logger.log("info", level, data);
  }
};

const authManager = new AuthManager({
  authDir: path.resolve(process.cwd(), "auths"),
  logger: logger,
});

const upstreamClient = new UpstreamClient(authManager, { logger });
const claudeApi = new ClaudeApi({ authManager, upstreamClient, logger, debug: debugRequestResponse });
const geminiApi = new GeminiApi({ authManager, upstreamClient, logger, debug: debugRequestResponse });

const isAddFlow = process.argv.includes("--add");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-api-key, x-goog-api-key, anthropic-version",
};

async function writeResponse(res, apiResponse) {
  const headers = { ...CORS_HEADERS, ...(apiResponse.headers || {}) };
  res.writeHead(apiResponse.status || 200, headers);

  const body = apiResponse.body;
  if (body == null) return res.end();

  // WHATWG ReadableStream (fetch Response.body)
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
    return;
  }

  // Node.js Readable
  if (body && typeof body.pipe === "function") {
    return body.pipe(res);
  }

  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return res.end(body);
  }

  return res.end(JSON.stringify(body));
}

const PORT = config.server?.port || 3000;
const HOST = config.server?.host || "0.0.0.0";

// 请求计数器
let requestCounter = 0;

function generateRequestId() {
  return `REQ-${Date.now().toString(36)}-${(++requestCounter).toString(36).padStart(4, "0")}`.toUpperCase();
}

const server = http.createServer(async (req, res) => {
  const requestId = generateRequestId();
  const startTime = Date.now();
  const clientIP = req.socket.remoteAddress || "unknown";

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  logger.logRequest(req.method, req.url, {
    requestId,
    headers: { 
      "user-agent": req.headers["user-agent"],
      "content-type": req.headers["content-type"],
      "x-forwarded-for": req.headers["x-forwarded-for"],
    },
  });

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Web UI (public)
    const uiResponse = await handleUiRoute(req, parsedUrl);
    if (uiResponse) {
      logger.logResponse(uiResponse.status || 200, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, uiResponse);
    }

    // OAuth callback (public, state-protected)
    const oauthCallbackResp = await handleOAuthCallbackRoute(req, parsedUrl, { authManager });
    if (oauthCallbackResp) {
      logger.logResponse(oauthCallbackResp.status || 200, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, oauthCallbackResp);
    }

    // Admin API (API key protected inside handler)
    const adminResp = await handleAdminRoute(req, parsedUrl, { authManager, upstreamClient, config, logger });
    if (adminResp) {
      logger.logResponse(adminResp.status || 200, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, adminResp);
    }

    // API Key Auth for upstream-compatible API endpoints
    if (config.api_keys && config.api_keys.length > 0) {
      const pathname = parsedUrl.pathname || "";
      const isApiEndpoint = pathname.startsWith("/v1/") || pathname === "/v1/models" || pathname.startsWith("/v1beta/");

      if (isApiEndpoint) {
        const apiKey = extractApiKey(req.headers);
        if (!apiKey || !config.api_keys.includes(apiKey)) {
          logger.log("warn", `⛔ 未授权的 API 访问尝试`, { 
            ip: clientIP, 
            path: pathname,
            requestId,
          });
          res.writeHead(401, { ...CORS_HEADERS, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API Key" } }));
          return;
        }
      }
    }

    // Claude models list
    if (parsedUrl.pathname === "/v1/models" && req.method === "GET") {
      const result = await claudeApi.handleListModels();
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    // Gemini models list
    if (parsedUrl.pathname === "/v1beta/models" && req.method === "GET") {
      const result = await geminiApi.handleListModels();
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    // Gemini model detail
    const geminiModelDetailMatch = parsedUrl.pathname.match(/^\/v1beta\/models\/([^:]+)$/);
    if (geminiModelDetailMatch && req.method === "GET") {
      const targetName = decodeURIComponent(geminiModelDetailMatch[1]);
      const result = await geminiApi.handleGetModel(targetName);
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    // Gemini generate/streamGenerate
    const geminiGenerateMatch = parsedUrl.pathname.match(
      /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/
    );
    if (geminiGenerateMatch && req.method === "POST") {
      const body = await parseJsonBody(req);
      logger.log("info", `🤖 Gemini 生成请求`, { 
        model: geminiGenerateMatch[1], 
        method: geminiGenerateMatch[2],
        stream: geminiGenerateMatch[2] === "streamGenerateContent",
        requestId,
      });
      const result = await geminiApi.handleGenerate(geminiGenerateMatch[1], geminiGenerateMatch[2], body, parsedUrl.search || "");
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    // Gemini countTokens (new, optional)
    const geminiCountMatch = parsedUrl.pathname.match(/^\/v1beta\/models\/([^:]+):countTokens$/);
    if (geminiCountMatch && req.method === "POST") {
      const body = await parseJsonBody(req);
      logger.log("info", `🔢 Gemini Token 计算请求`, { model: geminiCountMatch[1], requestId });
      const result = await geminiApi.handleCountTokens(geminiCountMatch[1], body);
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    // Claude count tokens
    if (parsedUrl.pathname === "/v1/messages/count_tokens" && req.method === "POST") {
      const body = await parseJsonBody(req);
      logger.log("info", `🔢 Claude Token 计算请求`, { model: body?.model, requestId });
      const result = await claudeApi.handleCountTokens(body);
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    // Claude messages
    if (parsedUrl.pathname === "/v1/messages" && req.method === "POST") {
      const body = await parseJsonBody(req);
      logger.log("info", `🤖 Claude 消息请求`, { 
        model: body?.model, 
        stream: !!body?.stream,
        messageCount: body?.messages?.length,
        requestId,
      });
      const result = await claudeApi.handleMessages(body);
      logger.logResponse(result.status, {
        requestId,
        duration: Date.now() - startTime,
      });
      return await writeResponse(res, result);
    }

    logger.log("warn", `❓ 未找到路由`, { method: req.method, path: req.url, requestId });
    res.writeHead(404, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Not Found: ${req.method} ${req.url}` } }));
  } catch (err) {
    if (err && err.message === "INVALID_JSON") {
      logger.log("warn", `📝 无效的 JSON 请求体`, { requestId });
      res.writeHead(400, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
      return;
    }
    logger.logError("请求处理失败", err, { requestId });
    res.writeHead(500, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
  }
});

(async () => {
  await authManager.loadAccounts();

  if (isAddFlow) {
    logger.log("info", "🚀 启动账户添加流程...");
    const oauthFlow = new OAuthFlow({ authManager, logger, rateLimiter: authManager.apiLimiter });
    const ok = await oauthFlow.startInteractiveFlow();
    if (!ok) {
      logger.log("error", "OAuth 流程未成功完成");
      return;
    }
    logger.log("success", "✅ 账户添加成功，启动服务器...");
  }

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger.log("fatal", `⛔ 端口 ${PORT} 已被占用`);
      process.exit(1);
    }
    logger.logError("服务器错误", err);
  });

  server.listen(PORT, HOST, () => {
    const separator = Box.horizontal.repeat(56);
    
    console.log(`\n${Colors.green}${Box.topLeft}${separator}${Box.topRight}${Colors.reset}`);
    console.log(`${Colors.green}${Box.vertical}${Colors.reset}  ${Colors.bold}🚀 Antigravity2API 服务器已启动${Colors.reset}${" ".repeat(25)}${Colors.green}${Box.vertical}${Colors.reset}`);
    console.log(`${Colors.green}${Box.vertical}${Colors.reset}${" ".repeat(56)}${Colors.green}${Box.vertical}${Colors.reset}`);
    console.log(`${Colors.green}${Box.vertical}${Colors.reset}  ${Colors.dim}📍 地址:${Colors.reset} http://${HOST}:${PORT}${" ".repeat(Math.max(0, 35 - HOST.length - String(PORT).length))}${Colors.green}${Box.vertical}${Colors.reset}`);
    console.log(`${Colors.green}${Box.vertical}${Colors.reset}  ${Colors.dim}🔗 Gemini:${Colors.reset} http://${HOST}:${PORT}/v1beta${" ".repeat(Math.max(0, 28 - HOST.length - String(PORT).length))}${Colors.green}${Box.vertical}${Colors.reset}`);
    console.log(`${Colors.green}${Box.vertical}${Colors.reset}  ${Colors.dim}🔗 Claude:${Colors.reset} http://${HOST}:${PORT}/v1/messages${" ".repeat(Math.max(0, 24 - HOST.length - String(PORT).length))}${Colors.green}${Box.vertical}${Colors.reset}`);
    console.log(`${Colors.green}${Box.vertical}${Colors.reset}  ${Colors.dim}📝 日志:${Colors.reset} ${logger.logFile.length > 40 ? "..." + logger.logFile.slice(-37) : logger.logFile}${" ".repeat(Math.max(0, 46 - Math.min(40, logger.logFile.length)))}${Colors.green}${Box.vertical}${Colors.reset}`);
    console.log(`${Colors.green}${Box.bottomLeft}${separator}${Box.bottomRight}${Colors.reset}\n`);

    if (authManager.accounts && authManager.accounts.length === 0) {
      logger.log("warn", "⚠️ 尚未加载任何账户");
      logger.log("info", `ℹ️  打开管理界面: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
      logger.log("info", "ℹ️  或运行 CLI OAuth: npm run add (或: node src/server.js --add)");
    } else {
      const accountCount = authManager.accounts?.length || 0;
      logger.log("success", `✅ 已加载 ${accountCount} 个账户`);
      logger.log("info", `ℹ️  管理界面: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}/`);
    }
  });
})().catch((err) => {
  logger.logError("启动失败", err);
  process.exit(1);
});
