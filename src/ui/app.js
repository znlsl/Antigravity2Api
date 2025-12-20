(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    apiKey: $("apiKey"),
    btnSaveKey: $("btnSaveKey"),
    btnClearKey: $("btnClearKey"),
    keyStatus: $("keyStatus"),
    btnReload: $("btnReload"),
    btnAdd: $("btnAdd"),
    oauthStatus: $("oauthStatus"),
    oauthUrl: $("oauthUrl"),
    oauthState: $("oauthState"),
    btnCopyUrl: $("btnCopyUrl"),
    accountsBody: $("accountsBody"),
    accountsMeta: $("accountsMeta"),
  };

  const state = {
    apiKey: "",
    oauth: { state: null, url: null },
  };

  function setStatus(text, type = "info") {
    const prefix = type === "error" ? "❌ " : type === "success" ? "✅ " : "ℹ️ ";
    els.keyStatus.textContent = prefix + text;
  }

  function loadApiKey() {
    try {
      const saved = localStorage.getItem("admin_api_key") || "";
      state.apiKey = saved;
      els.apiKey.value = saved;
      if (saved) setStatus("已加载本地保存的 API Key", "success");
      else setStatus("未设置 API Key（如果服务端配置了 api_keys，调用会 401）", "info");
    } catch (e) {
      setStatus("无法读取 localStorage", "error");
    }
  }

  function saveApiKey() {
    state.apiKey = (els.apiKey.value || "").trim();
    try {
      localStorage.setItem("admin_api_key", state.apiKey);
      setStatus(state.apiKey ? "API Key 已保存" : "API Key 已清空", "success");
    } catch (e) {
      setStatus("保存失败（localStorage 不可用）", "error");
    }
  }

  function clearApiKey() {
    els.apiKey.value = "";
    state.apiKey = "";
    try {
      localStorage.removeItem("admin_api_key");
    } catch (e) {}
    setStatus("已清除 API Key", "success");
  }

  async function apiFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    if (state.apiKey) headers["x-api-key"] = state.apiKey;
    if (!headers["Content-Type"] && options.method && options.method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(path, Object.assign({}, options, { headers }));
    const contentType = res.headers.get("Content-Type") || "";
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || (typeof data === "string" ? data : `HTTP ${res.status}`);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function formatExpiry(expiryDateMs) {
    if (!expiryDateMs) return "-";
    try {
      const d = new Date(expiryDateMs);
      if (Number.isNaN(d.getTime())) return "-";
      return d.toLocaleString();
    } catch (e) {
      return "-";
    }
  }

  function renderAccounts(payload) {
    const { count, current, accounts } = payload || {};
    els.accountsMeta.textContent = `账号数: ${count || 0}；当前索引 claude=${current?.claude ?? 0} / gemini=${current?.gemini ?? 0}`;

    els.accountsBody.innerHTML = "";
    if (!accounts || accounts.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "暂无账号，请先点击 “OAuth 添加账号”。";
      tr.appendChild(td);
      els.accountsBody.appendChild(tr);
      return;
    }

    for (const acc of accounts) {
      const tr = document.createElement("tr");

      const fileTd = document.createElement("td");
      fileTd.className = "mono";
      fileTd.textContent = acc.file || "-";

      const emailTd = document.createElement("td");
      emailTd.textContent = acc.email || "-";

      const pidTd = document.createElement("td");
      pidTd.className = "mono";
      pidTd.textContent = acc.projectId || "-";

      const expTd = document.createElement("td");
      expTd.textContent = formatExpiry(acc.expiry_date);

      const actTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.className = "btn small";
      delBtn.textContent = "删除";
      delBtn.addEventListener("click", async () => {
        if (!acc.file) return;
        const ok = confirm(`确认删除账号文件：${acc.file} ？`);
        if (!ok) return;
        try {
          await apiFetch(`/admin/api/accounts/${encodeURIComponent(acc.file)}`, { method: "DELETE" });
          await refreshAccounts();
        } catch (e) {
          alert(`删除失败：${e.message || e}`);
        }
      });
      actTd.appendChild(delBtn);

      tr.appendChild(fileTd);
      tr.appendChild(emailTd);
      tr.appendChild(pidTd);
      tr.appendChild(expTd);
      tr.appendChild(actTd);
      els.accountsBody.appendChild(tr);
    }
  }

  async function refreshAccounts() {
    try {
      const res = await apiFetch("/admin/api/accounts", { method: "GET" });
      renderAccounts(res.data);
    } catch (e) {
      if (e.status === 401) {
        els.accountsMeta.textContent = "未授权：请先输入正确的 API Key";
        els.accountsBody.innerHTML = "";
        return;
      }
      els.accountsMeta.textContent = `加载失败：${e.message || e}`;
      els.accountsBody.innerHTML = "";
    }
  }

  function setOAuthInfo({ status, url, stateId }) {
    els.oauthStatus.textContent = status || "-";
    els.oauthState.textContent = stateId || "-";
    if (url) {
      els.oauthUrl.textContent = url;
      els.oauthUrl.href = url;
    } else {
      els.oauthUrl.textContent = "-";
      els.oauthUrl.href = "#";
    }
  }

  async function startOAuth() {
    setOAuthInfo({ status: "生成授权链接中..." });
    try {
      const res = await apiFetch("/admin/api/oauth/start", { method: "POST", body: "{}" });
      const data = res.data;
      state.oauth.state = data.state;
      state.oauth.url = data.auth_url;
      setOAuthInfo({ status: "请在弹窗完成授权", url: data.auth_url, stateId: data.state });

      const popup = window.open(data.auth_url, "_blank");
      if (!popup) {
        setOAuthInfo({ status: "弹窗被拦截，请手动点击链接打开", url: data.auth_url, stateId: data.state });
      }
    } catch (e) {
      if (e.status === 401) {
        setOAuthInfo({ status: "未授权：请先输入正确的 API Key" });
        return;
      }
      setOAuthInfo({ status: `启动失败：${e.message || e}` });
    }
  }

  function handleOAuthMessage(event) {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.type !== "oauth_result") return;
    if (state.oauth.state && data.state && data.state !== state.oauth.state) return;

    if (data.success) {
      setOAuthInfo({ status: `授权成功：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
      refreshAccounts();
    } else {
      setOAuthInfo({ status: `授权失败：${data.message || ""}`, url: state.oauth.url, stateId: state.oauth.state });
    }
  }

  async function copyOAuthUrl() {
    const url = state.oauth.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setOAuthInfo({ status: "已复制授权链接", url, stateId: state.oauth.state });
    } catch (e) {
      alert("复制失败，请手动复制");
    }
  }

  function bindEvents() {
    els.btnSaveKey.addEventListener("click", () => {
      saveApiKey();
      refreshAccounts();
    });
    els.btnClearKey.addEventListener("click", () => {
      clearApiKey();
      refreshAccounts();
    });
    els.btnReload.addEventListener("click", async () => {
      try {
        await apiFetch("/admin/api/accounts/reload", { method: "POST", body: "{}" });
      } catch (e) {}
      refreshAccounts();
    });
    els.btnAdd.addEventListener("click", startOAuth);
    els.btnCopyUrl.addEventListener("click", copyOAuthUrl);
    window.addEventListener("message", handleOAuthMessage);
  }

  loadApiKey();
  bindEvents();
  refreshAccounts();
})();

