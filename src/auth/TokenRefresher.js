const path = require("path");

class TokenRefresher {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.refreshFn = typeof options.refreshFn === "function" ? options.refreshFn : null;
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

  logAccount(action, options = {}) {
    if (this.logger && typeof this.logger.logAccount === "function") {
      return this.logger.logAccount(action, options);
    }
    this.log("account", { action, ...options });
  }

  async refresh(account) {
    if (!this.refreshFn) {
      throw new Error("TokenRefresher.refreshFn not configured");
    }
    return this.refreshFn(account);
  }

  scheduleRefresh(account) {
    if (!account) return;
    if (account.refreshTimer) {
      clearTimeout(account.refreshTimer);
      account.refreshTimer = null;
    }

    const now = Date.now();
    // 提前 10 分钟刷新
    const targetTime = account.creds.expiry_date - 10 * 60 * 1000;
    let delay = targetTime - now;
    if (delay < 0) delay = 0;

    account.refreshTimer = setTimeout(() => {
      const accountName = path.basename(account.filePath);
      this.logAccount("自动刷新 Token", { account: accountName });
      this.refresh(account).catch((e) => {
        this.log("error", `❌ 自动刷新失败 (${accountName}): ${e.message || e}`);
        // 失败后 1 分钟重试
        account.refreshTimer = setTimeout(() => {
          this.scheduleRefresh(account);
        }, 60 * 1000);
      });
    }, delay);
  }

  cancelRefresh(account) {
    if (!account) return;
    if (account.refreshTimer) {
      clearTimeout(account.refreshTimer);
      account.refreshTimer = null;
    }
  }
}

module.exports = TokenRefresher;

