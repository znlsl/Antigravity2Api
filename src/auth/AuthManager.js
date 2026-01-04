const path = require("path");
const fs = require("fs/promises");

const RateLimiter = require("./RateLimiter");
const TokenRefresher = require("./TokenRefresher");
const httpClient = require("./httpClient");

function generateProjectId() {
  // 生成类似 "fabled-setup-3dmkj" 的格式：word-word-5位随机
  const adjectives = [
    "fabled",
    "spry",
    "apt",
    "astral",
    "infra",
    "brisk",
    "calm",
    "daring",
    "eager",
    "gentle",
    "lively",
    "noble",
    "quick",
    "rural",
    "solar",
    "tidy",
    "vivid",
    "witty",
    "young",
    "zesty",
  ];
  const nouns = [
    "setup",
    "post",
    "site",
    "scout",
    "battery",
    "arbor",
    "beacon",
    "canyon",
    "delta",
    "ember",
    "grove",
    "harbor",
    "meadow",
    "nexus",
    "prairie",
    "ridge",
    "savanna",
    "tundra",
    "valley",
    "willow",
  ];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  // 生成 5 位 base36 随机串
  let suffix = "";
  while (suffix.length < 5) {
    suffix += require("crypto").randomBytes(4).readUInt32BE().toString(36);
  }
  suffix = suffix.slice(0, 5);
  return `${adj}-${noun}-${suffix}`;
}

function normalizeQuotaGroup(group) {
  const g = String(group || "").trim().toLowerCase();
  if (g === "claude") return "claude";
  if (g === "gemini") return "gemini";
  return "gemini";
}

function sanitizeCredentialFileName(fileName) {
  const name = String(fileName || "").trim();
  if (!name) throw new Error("file name is required");
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("invalid file name");
  }
  if (!name.endsWith(".json")) {
    throw new Error("invalid credentials file (must be .json)");
  }
  return name;
}

class AuthManager {
  constructor(options = {}) {
    this.authDir = options.authDir || path.resolve(process.cwd(), "auths");
    this.accounts = [];
    // Claude/Gemini quotas are independent; keep rotation state per group.
    this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    this.logger = options.logger || null;
    // Ensure v1internal requests are spaced >= 500ms.
    this.apiLimiter = options.rateLimiter || new RateLimiter(500);
    this.lastLoadCodeAssistBody = null;

    this.tokenRefresher = new TokenRefresher({
      logger: this.logger,
      refreshFn: this.refreshToken.bind(this),
    });
  }

  setLogger(logger) {
    this.logger = logger;
    if (this.tokenRefresher) {
      this.tokenRefresher.logger = logger;
    }
  }

  log(title, data) {
    if (this.logger) {
      // 支持新的日志 API
      if (typeof this.logger.log === "function") {
        return this.logger.log(title, data);
      }
      // 兼容旧的日志函数
      return this.logger(title, data);
    }
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
    }
  }

  logAccount(action, options = {}) {
    if (this.logger && typeof this.logger.logAccount === "function") {
      return this.logger.logAccount(action, options);
    }
    this.log("account", { action, ...options });
  }

  async waitForApiSlot() {
    if (this.apiLimiter) {
      await this.apiLimiter.wait();
    }
  }

  getAccountCount() {
    return this.accounts.length;
  }

  getAccountsSummary() {
    return this.accounts.map((account, index) => ({
      index,
      file: path.basename(account.filePath),
      email: account.creds?.email || null,
      projectId: account.creds?.projectId || null,
      expiry_date: Number.isFinite(account.creds?.expiry_date) ? account.creds.expiry_date : null,
      token_type: account.creds?.token_type || null,
      scope: account.creds?.scope || null,
    }));
  }

  getCurrentAccountIndex(group) {
    const g = normalizeQuotaGroup(group);
    if (!this.currentAccountIndexByGroup || typeof this.currentAccountIndexByGroup !== "object") {
      this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    }
    const idx = this.currentAccountIndexByGroup[g];
    return Number.isInteger(idx) ? idx : 0;
  }

  setCurrentAccountIndex(group, index) {
    const g = normalizeQuotaGroup(group);
    if (!this.currentAccountIndexByGroup || typeof this.currentAccountIndexByGroup !== "object") {
      this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    }
    this.currentAccountIndexByGroup[g] = index;
  }

  rotateAccount(group) {
    const g = normalizeQuotaGroup(group);
    if (this.accounts.length <= 1) return false;
    const nextIndex = (this.getCurrentAccountIndex(g) + 1) % this.accounts.length;
    this.setCurrentAccountIndex(g, nextIndex);
    const accountName = path.basename(this.accounts[nextIndex].filePath);
    this.logAccount(`轮换账户`, {
      group: g,
      account: accountName,
      reason: `切换到第 ${nextIndex + 1}/${this.accounts.length} 个账户`,
    });
    return true;
  }

  async deleteAccountByFile(fileName) {
    const safeName = sanitizeCredentialFileName(fileName);
    const idx = this.accounts.findIndex((a) => path.basename(a.filePath) === safeName);
    if (idx === -1) {
      return false;
    }

    const account = this.accounts[idx];

    if (this.tokenRefresher) {
      this.tokenRefresher.cancelRefresh(account);
    } else if (account.refreshTimer) {
      clearTimeout(account.refreshTimer);
      account.refreshTimer = null;
    }

    await fs.unlink(account.filePath).catch(() => {});
    this.accounts.splice(idx, 1);

    for (const group of ["claude", "gemini"]) {
      const current = this.getCurrentAccountIndex(group);
      if (this.accounts.length === 0) {
        this.setCurrentAccountIndex(group, 0);
        continue;
      }
      if (idx < current) {
        this.setCurrentAccountIndex(group, Math.max(0, current - 1));
      } else if (idx === current) {
        this.setCurrentAccountIndex(group, Math.min(current, this.accounts.length - 1));
      }
    }

    return true;
  }

  async loadAccounts() {
    this.accounts = [];
    this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    try {
      // Ensure auth directory exists
      try {
        await fs.access(this.authDir);
      } catch {
        await fs.mkdir(this.authDir, { recursive: true });
      }

      const files = await fs.readdir(this.authDir);
      const candidates = files.filter((f) => f.endsWith(".json") && !f.startsWith("package") && f !== "tsconfig.json");

      let loadedCount = 0;
      for (const file of candidates) {
        try {
          const filePath = path.join(this.authDir, file);
          const content = await fs.readFile(filePath, "utf8");
          try {
            const creds = JSON.parse(content);
            if (creds.access_token && creds.refresh_token && (creds.token_type || creds.scope)) {
              this.accounts.push({
                filePath,
                creds,
                refreshPromise: null,
                refreshTimer: null,
                projectPromise: null,
              });
              loadedCount++;
            }
          } catch (parseErr) {}
        } catch (e) {}
      }

      if (loadedCount === 0) {
        this.log("warn", "⚠️ 未找到任何账户");
        return;
      }

      this.log("success", `✅ 已加载 ${this.accounts.length} 个账户`);

      for (const account of this.accounts) {
        this.tokenRefresher.scheduleRefresh(account);
      }
    } catch (err) {
      this.log("error", `Error loading accounts: ${err.message || err}`);
    }
  }

  async reloadAccounts() {
    if (Array.isArray(this.accounts)) {
      for (const account of this.accounts) {
        if (this.tokenRefresher) {
          this.tokenRefresher.cancelRefresh(account);
        } else if (account?.refreshTimer) {
          clearTimeout(account.refreshTimer);
          account.refreshTimer = null;
        }
      }
    }

    await this.loadAccounts();
    return this.getAccountsSummary();
  }

  async fetchProjectId(accessToken) {
    await this.waitForApiSlot();
    const { projectId, rawBody } = await httpClient.fetchProjectId(accessToken, this.apiLimiter);
    this.lastLoadCodeAssistBody = rawBody;
    return projectId;
  }

  async ensureProjectId(account) {
    if (account.creds.projectId) {
      return account.creds.projectId;
    }

    if (account.projectPromise) {
      return account.projectPromise;
    }

    account.projectPromise = (async () => {
      let projectId = account.creds.projectId;

      if (!projectId) {
        projectId = await this.fetchProjectId(account.creds.access_token);
      }

      if (!projectId) {
        const lastRaw = this.lastLoadCodeAssistBody;
        const hasPaidTier = lastRaw && lastRaw.includes('"paidTier"');
        if (hasPaidTier) {
          projectId = generateProjectId();
          this.log("warn", `loadCodeAssist 无 projectId，但检测到 paidTier，使用随机 projectId: ${projectId}`);
        }
      }

      if (!projectId) {
        throw new Error("Account is not eligible (projectId missing)");
      }

      account.creds.projectId = projectId;
      await fs.writeFile(account.filePath, JSON.stringify(account.creds, null, 2));
      this.log("info", `✅ 获取 projectId 成功: ${projectId}`);
      return projectId;
    })();

    try {
      return await account.projectPromise;
    } finally {
      account.projectPromise = null;
    }
  }

  async getCredentials(group) {
    if (this.accounts.length === 0) {
      throw new Error("No accounts available. Please authenticate first.");
    }

    const quotaGroup = normalizeQuotaGroup(group);
    const accountIndex = this.getCurrentAccountIndex(quotaGroup);
    const account = this.accounts[accountIndex];

    if (account.refreshPromise) {
      await account.refreshPromise;
    }

    if (account.creds.expiry_date < +new Date()) {
      const accountName = path.basename(account.filePath);
      this.log("info", `Refreshing token for [${quotaGroup}] account ${accountIndex + 1} (${accountName})...`);
      await this.refreshToken(account);
    }

    await this.ensureProjectId(account);

    return {
      accessToken: account.creds.access_token,
      projectId: account.creds.projectId,
      account,
    };
  }

  async getCurrentAccessToken(group) {
    const { accessToken } = await this.getCredentials(group);
    return accessToken;
  }

  async fetchAvailableModels() {
    const accessToken = await this.getCurrentAccessToken();
    await this.waitForApiSlot();
    return httpClient.fetchAvailableModels(accessToken, this.apiLimiter);
  }

  async fetchUserInfo(accessToken) {
    await this.waitForApiSlot();
    return httpClient.fetchUserInfo(accessToken, this.apiLimiter);
  }

  async addAccount(formattedData) {
    const previousClaudeIndex = this.getCurrentAccountIndex("claude");
    const previousGeminiIndex = this.getCurrentAccountIndex("gemini");
    const hadAccountsBefore = this.accounts.length > 0;

    // Ensure auth directory exists
    try {
      await fs.access(this.authDir);
    } catch {
      await fs.mkdir(this.authDir, { recursive: true });
    }

    // Fetch projectId：先尝试 API 获取；如果没有，且检测到 paidTier 则随机生成
    let projectId = await this.fetchProjectId(formattedData.access_token);
    if (!projectId) {
      const hasPaidTier = this.lastLoadCodeAssistBody && this.lastLoadCodeAssistBody.includes('"paidTier"');
      if (hasPaidTier) {
        projectId = generateProjectId();
        this.log("warn", `loadCodeAssist 无 projectId，但检测到 paidTier，使用随机 projectId: ${projectId}`);
      }
    }
    if (!projectId) {
      throw new Error("Failed to obtain projectId, account is not eligible");
    }
    formattedData.projectId = projectId;
    this.log("info", `✅ 项目ID获取成功: ${projectId}`);

    const email = formattedData.email;

    // Check for duplicates
    let targetFilePath = null;
    let existingAccountIndex = -1;

    if (email) {
      for (let i = 0; i < this.accounts.length; i++) {
        const acc = this.accounts[i];

        let accEmail = acc.creds.email;
        if (!accEmail) {
          if (acc.creds.expiry_date > +new Date()) {
            const accInfo = await this.fetchUserInfo(acc.creds.access_token);
            if (accInfo && accInfo.email) {
              accEmail = accInfo.email;
              acc.creds.email = accEmail;
            }
          }
        }

        if (accEmail && accEmail === email) {
          targetFilePath = acc.filePath;
          existingAccountIndex = i;
          this.log("info", `Found existing account for ${email}, updating...`);
          break;
        }
      }
    }

    // Determine filename
    if (existingAccountIndex !== -1) {
      targetFilePath = this.accounts[existingAccountIndex].filePath;

      // Migrate to email-based filename if possible
      if (email) {
        const safeEmail = email.replace(/[^a-zA-Z0-9@.]/g, "_");
        const newPath = path.join(this.authDir, `${safeEmail}.json`);

        if (targetFilePath !== newPath) {
          try {
            await fs.unlink(targetFilePath).catch(() => {});
            targetFilePath = newPath;
            this.accounts[existingAccountIndex].filePath = newPath;
            this.log("info", `Renamed credentials to ${path.basename(newPath)}`);
          } catch (e) {
            this.log("error", `Error renaming file: ${e.message || e}`);
          }
        }
      }
    } else {
      if (email) {
        const safeEmail = email.replace(/[^a-zA-Z0-9@.]/g, "_");
        targetFilePath = path.join(this.authDir, `${safeEmail}.json`);
      } else {
        targetFilePath = path.join(this.authDir, `oauth-${Date.now()}.json`);
      }
    }

    await fs.writeFile(targetFilePath, JSON.stringify(formattedData, null, 2));

    let targetAccount;
    if (existingAccountIndex !== -1) {
      this.accounts[existingAccountIndex].creds = formattedData;
      targetAccount = this.accounts[existingAccountIndex];
    } else {
      targetAccount = {
        filePath: targetFilePath,
        creds: formattedData,
        refreshPromise: null,
        refreshTimer: null,
        projectPromise: null,
      };
      this.accounts.push(targetAccount);
    }

    // Adding/updating an account should not implicitly change current selection.
    // (If this is the first account, default to index 0.)
    const clampIndex = (idx) => {
      if (this.accounts.length === 0) return 0;
      const n = Number.isInteger(idx) ? idx : 0;
      return Math.max(0, Math.min(n, this.accounts.length - 1));
    };

    if (!hadAccountsBefore) {
      this.setCurrentAccountIndex("claude", 0);
      this.setCurrentAccountIndex("gemini", 0);
    } else {
      this.setCurrentAccountIndex("claude", clampIndex(previousClaudeIndex));
      this.setCurrentAccountIndex("gemini", clampIndex(previousGeminiIndex));
    }

    this.tokenRefresher.scheduleRefresh(targetAccount);

    this.log("info", "✅ OAuth authentication successful! Credentials saved.");
    this.log("info", "ℹ️  To add more accounts, run: npm run add (or: node src/server.js --add)");
    this.log("info", "🚀 You can now use the API.");
  }

  async refreshToken(account) {
    if (account.refreshPromise) {
      return account.refreshPromise;
    }

    account.refreshPromise = (async () => {
      try {
        const refresh_token = account.creds.refresh_token;
        await this.waitForApiSlot();
        const data = await httpClient.refreshToken(refresh_token, this.apiLimiter);

        // 保持 email 字段 (如果有)
        if (account.creds.email) {
          data.email = account.creds.email;
        }

        // 补全 projectId（刷新可能首次需要）
        if (account.creds.projectId) {
          data.projectId = account.creds.projectId;
        } else {
          const projectId = await this.fetchProjectId(data.access_token);
          if (!projectId) {
            const hasPaidTier =
              this.lastLoadCodeAssistBody && this.lastLoadCodeAssistBody.includes('"paidTier"');
            if (hasPaidTier) {
              data.projectId = generateProjectId();
              this.log(
                "warn",
                `⚠️ 刷新时 loadCodeAssist 无 projectId，但检测到 paidTier，使用随机 projectId: ${data.projectId}`
              );
            } else {
              throw new Error("Failed to obtain projectId during refresh");
            }
          } else {
            data.projectId = projectId;
            this.log("info", `✅ 刷新时获取 projectId 成功: ${projectId}`);
          }
        }

        account.creds = data;
        await fs.writeFile(account.filePath, JSON.stringify(data, null, 2));
        this.log("info", `✅ Token refreshed for ${path.basename(account.filePath)}`);

        this.tokenRefresher.scheduleRefresh(account);

        return data.access_token;
      } finally {
        account.refreshPromise = null;
      }
    })();

    return account.refreshPromise;
  }
}

module.exports = AuthManager;
