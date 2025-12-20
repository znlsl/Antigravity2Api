async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error("INVALID_JSON");
    err.cause = e;
    throw err;
  }
}

function extractApiKey(headers) {
  const authHeader = headers["authorization"];
  let apiKey = null;
  if (authHeader) {
    const parts = String(authHeader).trim().split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      apiKey = parts[1];
    } else {
      apiKey = String(authHeader).trim();
    }
  } else {
    const xApiKey = headers["x-api-key"] || headers["anthropic-api-key"] || headers["x-goog-api-key"];
    if (xApiKey) apiKey = String(xApiKey).trim();
  }
  return apiKey;
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  };
}

function textResponse(status, body, headers = {}) {
  return {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
    body,
  };
}

function htmlResponse(status, body, headers = {}) {
  return {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
    body,
  };
}

module.exports = {
  parseJsonBody,
  extractApiKey,
  jsonResponse,
  textResponse,
  htmlResponse,
};
