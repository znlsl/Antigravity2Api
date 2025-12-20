const crypto = require("crypto");

const V1INTERNAL_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";

function buildV1InternalUrl(method, queryString = "") {
  const qs = queryString ? String(queryString) : "";
  return `${V1INTERNAL_BASE_URL}:${method}${qs}`;
}

// OAuth client configuration: allow env override, fallback to built-in defaults (same as Antigravity2api)
function getOAuthClient() {
  const defaultClientId =
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
  const defaultClientSecret = "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";
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID ||
    process.env.GCP_CLIENT_ID ||
    process.env.CLIENT_ID ||
    defaultClientId;
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    process.env.GCP_CLIENT_SECRET ||
    process.env.CLIENT_SECRET ||
    defaultClientSecret;
  return { clientId, clientSecret };
}

async function waitForApiSlot(limiter) {
  if (limiter && typeof limiter.wait === "function") {
    await limiter.wait();
  }
}

/**
 * Raw v1internal call helper.
 * This is the single place where cloudcode-pa.googleapis.com/v1internal is fetched.
 *
 * @param {string} method - v1internal method name (e.g. "generateContent", "countTokens")
 * @param {string} accessToken
 * @param {object} body
 * @param {object} [options]
 * @param {string} [options.queryString] - Includes leading "?" (e.g. "?alt=sse")
 * @param {object} [options.headers] - Extra headers to merge.
 * @param {any} [options.limiter] - RateLimiter instance (must have wait()).
 * @returns {Promise<Response>}
 */
async function callV1Internal(method, accessToken, body, options = {}) {
  const queryString = options.queryString || "";
  const extraHeaders = options.headers && typeof options.headers === "object" ? options.headers : {};
  const limiter = options.limiter;

  await waitForApiSlot(limiter);
  return fetch(buildV1InternalUrl(method, queryString), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "antigravity/1.11.9 windows/amd64",
      ...extraHeaders,
    },
    body: JSON.stringify(body || {}),
  });
}

async function fetchProjectId(accessToken, limiter) {
  await waitForApiSlot(limiter);
  const response = await fetch(buildV1InternalUrl("loadCodeAssist"), {
    method: "POST",
    headers: {
      Host: "cloudcode-pa.googleapis.com",
      "User-Agent": "antigravity/1.11.9 windows/amd64",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Accept-Encoding": "gzip",
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
  });

  const rawBody = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(
      `Failed to fetch projectId: ${response.status} ${response.statusText} ${rawBody}`.trim()
    );
  }

  let data = {};
  try {
    data = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {}

  return { projectId: data?.cloudaicompanionProject, rawBody };
}

async function fetchAvailableModels(accessToken, limiter) {
  await waitForApiSlot(limiter);
  const response = await fetch(buildV1InternalUrl("fetchAvailableModels"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "antigravity/1.11.9 windows/amd64",
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.models || {};
}

async function fetchUserInfo(accessToken, limiter) {
  try {
    await waitForApiSlot(limiter);
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {}
  return null;
}

function resolveRedirectUri(portOrRedirectUri) {
  if (typeof portOrRedirectUri === "string" && portOrRedirectUri.trim()) {
    return portOrRedirectUri.trim();
  }

  if (
    portOrRedirectUri &&
    typeof portOrRedirectUri === "object" &&
    typeof portOrRedirectUri.redirectUri === "string" &&
    portOrRedirectUri.redirectUri.trim()
  ) {
    return portOrRedirectUri.redirectUri.trim();
  }

  const port =
    typeof portOrRedirectUri === "number"
      ? portOrRedirectUri
      : typeof portOrRedirectUri?.port === "number"
        ? portOrRedirectUri.port
        : 50000;
  return `http://localhost:${port}/oauth-callback`;
}

async function exchangeCodeForToken(code, portOrRedirectUri = 50000, limiter) {
  const { clientId, clientSecret } = getOAuthClient();
  const redirectUri = resolveRedirectUri(portOrRedirectUri);
  await waitForApiSlot(limiter);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "user-agent": "google-api-nodejs-client/10.3.0",
      "x-goog-api-client": "gl-node/22.18.0",
      Host: "oauth2.googleapis.com",
      Connection: "close",
    },
    body: new URLSearchParams({
      client_id: clientId,
      code: code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      client_secret: clientSecret,
    }).toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Failed to get token: ${data.error_description || data.error}`);
  }

  // Add expiry timestamp
  data.expiry_date = new Date().getTime() + data.expires_in * 1000 - 1000 * 60;
  delete data.expires_in;

  const userInfo = await fetchUserInfo(data.access_token, limiter);
  const email = userInfo ? userInfo.email : null;

  // Format data to save (keep same shape as current credentials)
  const formattedData = {
    access_token: data.access_token,
    expiry_date: data.expiry_date,
    expires_in: data.expires_in || Math.floor((data.expiry_date - Date.now()) / 1000),
    refresh_token: data.refresh_token || "",
    scope: data.scope,
    token_type: data.token_type,
    id_token: data.id_token || "",
    email: email,
  };

  return formattedData;
}

async function refreshToken(refreshTokenValue, limiter) {
  const { clientId, clientSecret } = getOAuthClient();
  await waitForApiSlot(limiter);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshTokenValue,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error("Failed to refresh token: " + JSON.stringify(data));
  }

  data.expiry_date = new Date().getTime() + data.expires_in * 1000 - 1000 * 60;
  if (!data.refresh_token) {
    data.refresh_token = refreshTokenValue;
  }
  delete data.expires_in;

  return data;
}

function randomId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

module.exports = {
  getOAuthClient,
  callV1Internal,
  fetchProjectId,
  fetchAvailableModels,
  fetchUserInfo,
  exchangeCodeForToken,
  refreshToken,
  randomId,
};
