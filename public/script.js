let adminToken = sessionStorage.getItem("keySystemAdminToken") || "";
let keys = [];

const $ = (id) => document.getElementById(id);

function show(view) {
  $("login-view").classList.toggle("is-hidden", view !== "login");
  $("dashboard-view").classList.toggle("is-hidden", view !== "dashboard");
}

function showResult(element, message, isError = false) {
  element.textContent = message;
  element.classList.remove("is-hidden");
  element.classList.toggle("error", isError);
}

function showGeneratedKey(element, data) {
  element.classList.remove("is-hidden", "error");
  element.innerHTML = `
    <div class="generated-summary">
      <div>
        <span>Key</span>
        <strong class="key-code">${escapeHtml(data.key)}</strong>
      </div>
      <div>
        <span>Expires</span>
        <strong title="${escapeHtml(formatDate(data.expiresAt))}">${formatExpires(data.expiresAt)}</strong>
      </div>
      <div>
        <span>Max devices</span>
        <strong>${data.maxUses}</strong>
      </div>
      <div>
        <span>Script URL</span>
        <strong class="url-value" title="${escapeHtml(data.scriptUrl || "")}">${escapeHtml(data.scriptUrl || "Not set")}</strong>
      </div>
    </div>
    <div class="generated-code">
      <div class="snippet-head">
        <strong>Loadstring</strong>
        <button type="button" class="secondary" data-copy-output="generated-loadstring">Copy</button>
      </div>
      <pre><code id="generated-loadstring">${escapeHtml(data.loadstring || "")}</code></pre>
    </div>
  `;
}

async function api(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": adminToken,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(data.message || data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function copyText(value) {
  const text = String(value || "");

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Copy failed. Select the text and copy it manually.");
  }
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleDateString();
}

function formatExpires(value) {
  if (!value) return "Never";
  const expiresAt = new Date(value).getTime();
  if (Number.isNaN(expiresAt)) return "Never";

  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return "Expired";

  const totalMinutes = Math.ceil(diffMs / 60000);
  const totalHours = Math.ceil(diffMs / 3600000);
  const totalDays = Math.ceil(diffMs / 86400000);

  if (totalMinutes < 60) {
    return `${totalMinutes} min left`;
  }
  if (totalHours < 48) {
    return `${totalHours} hr${totalHours === 1 ? "" : "s"} left`;
  }
  return `${totalDays} day${totalDays === 1 ? "" : "s"} left`;
}

function getKeyStatus(key) {
  if (!key.is_active) return { label: "Inactive", className: "status-inactive" };
  if (Number(key.blacklisted_count || 0) > 0) return { label: "Blacklisted", className: "status-expired" };
  if (key.expired) return { label: "Expired", className: "status-expired" };
  if (key.used_count > 0) return { label: "Bound", className: "status-used" };
  return { label: "Active", className: "status-active" };
}

function renderStats() {
  $("stat-total").textContent = keys.length;
  $("stat-active").textContent = keys.filter((key) => key.is_active && !key.expired).length;
  $("stat-bound").textContent = keys.reduce((total, key) => total + Number(key.used_count || 0), 0);
}

function renderKeys() {
  const filter = $("key-filter").value.trim().toLowerCase();
  const table = $("keys-table");
  table.innerHTML = "";

  const filteredKeys = keys.filter((key) => {
    return !filter ||
      key.key.toLowerCase().includes(filter) ||
      (key.execution_ips || []).join(" ").toLowerCase().includes(filter) ||
      String(key.script_url || "").toLowerCase().includes(filter) ||
      String(key.notes || "").toLowerCase().includes(filter);
  });

  if (!filteredKeys.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="8">No keys found.</td>';
    table.appendChild(row);
    return;
  }

  for (const key of filteredKeys) {
    const status = getKeyStatus(key);
    const isBlacklisted = Number(key.blacklisted_count || 0) > 0;
    const executionIps = key.execution_ips && key.execution_ips.length
      ? key.execution_ips.map((ip) => `<span>${escapeHtml(ip)}</span>`).join("")
      : '<span class="muted-inline">No executions</span>';
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="key-code">${escapeHtml(key.key)}</span></td>
      <td><span class="status-pill ${status.className}">${escapeHtml(status.label)}</span></td>
      <td>${Number(key.used_count || 0)}/${Number(key.max_uses || key.max_devices || 1)}</td>
      <td><div class="ip-list">${executionIps}</div></td>
      <td><span title="${escapeHtml(formatDate(key.expires_at))}">${formatExpires(key.expires_at)}</span></td>
      <td><span class="url-cell" title="${escapeHtml(key.script_url || "")}">${escapeHtml(key.script_url || "Not set")}</span></td>
      <td>${escapeHtml(key.notes || "")}</td>
      <td class="actions-cell">
        <div class="row-actions">
          <button type="button" class="secondary" data-copy-loadstring="${escapeHtml(key.key)}">Copy</button>
          <button type="button" class="${key.is_active ? "danger" : ""}" data-toggle="${escapeHtml(key.key)}" data-active="${key.is_active ? "0" : "1"}">
            ${key.is_active ? "Disable" : "Enable"}
          </button>
          <button type="button" class="${isBlacklisted ? "secondary" : "danger"}" data-blacklist-toggle="${escapeHtml(key.key)}" data-blacklisted="${isBlacklisted ? "1" : "0"}">
            ${isBlacklisted ? "Unblacklist" : "Blacklist"}
          </button>
          <button type="button" class="danger" data-delete="${escapeHtml(key.key)}">Remove</button>
        </div>
      </td>
    `;
    table.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderIntegrationSnippets() {
  const loaderUrl = `${window.location.origin}/api/loader`;

  $("curl-snippet").textContent = `script_key="KEY-ABCD-EFGH-JKLM-NPQR"; loadstring(game:HttpGet("${loaderUrl}", true))()`;

  $("js-snippet").textContent = [
    `GET  ${loaderUrl}`,
    "Returns the Lua loader used by the loadstring.",
    "",
    `POST ${loaderUrl}`,
    "Validates { key, hwid, userId } and returns { success, script } when authorized.",
  ].join("\n");
}

function buildLoadstring(key) {
  return `script_key="${key}"; loadstring(game:HttpGet("${window.location.origin}/api/loader", true))()`;
}

async function loadAllKeys() {
  const data = await api("/api/all-keys");
  keys = data.data || [];
  renderStats();
  renderKeys();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  adminToken = $("admin-token").value.trim();
  if (!adminToken) return;

  try {
    sessionStorage.setItem("keySystemAdminToken", adminToken);
    await loadAllKeys();
    show("dashboard");
  } catch (error) {
    sessionStorage.removeItem("keySystemAdminToken");
    showResult($("generated-key"), error.message, true);
    alert(error.message);
  }
});

$("logout").addEventListener("click", () => {
  adminToken = "";
  sessionStorage.removeItem("keySystemAdminToken");
  show("login");
});

$("refresh-keys").addEventListener("click", () => {
  loadAllKeys().catch((error) => alert(error.message));
});

$("generate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = $("generated-key");

  try {
    const data = await api("/api/generate-key", {
      expiresIn: Number($("expires-in").value || 0),
      expiresInUnit: $("expires-unit").value,
      maxUses: Number($("max-uses").value || 1),
      scriptUrl: $("script-url").value.trim(),
      notes: $("notes").value.trim(),
    });
    showGeneratedKey(output, data);
    await loadAllKeys();
  } catch (error) {
    showResult(output, error.message, true);
  }
});

$("reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = $("device-result");

  try {
    const data = await api("/api/reset-hwid", {
      key: $("reset-key").value.trim(),
      deviceId: $("reset-device").value.trim(),
    });
    showResult(output, `${data.message}. Updated rows: ${data.changed}`);
    await loadAllKeys();
  } catch (error) {
    showResult(output, error.message, true);
  }
});

$("key-filter").addEventListener("input", renderKeys);

setInterval(() => {
  if (!$("dashboard-view").classList.contains("is-hidden")) {
    renderKeys();
  }
}, 60000);

$("keys-table").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const copyLoadstringKey = button.dataset.copyLoadstring;
  const toggleKey = button.dataset.toggle;
  const blacklistToggleKey = button.dataset.blacklistToggle;
  const deleteKey = button.dataset.delete;

  if (copyLoadstringKey) {
    try {
      await copyText(buildLoadstring(copyLoadstringKey));
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 900);
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  if (toggleKey) {
    try {
      await api("/api/toggle-key", {
        key: toggleKey,
        isActive: button.dataset.active === "1",
      });
      await loadAllKeys();
    } catch (error) {
      alert(error.message);
    }
    return;
  }

  if (blacklistToggleKey) {
    const isBlacklisted = button.dataset.blacklisted === "1";
    const confirmed = window.confirm(
      isBlacklisted
        ? `Unblacklist devices registered to ${blacklistToggleKey}?`
        : `Blacklist devices registered to ${blacklistToggleKey}?`
    );
    if (!confirmed) return;

    try {
      const data = await api(isBlacklisted ? "/api/unblacklist-key-devices" : "/api/blacklist-key-devices", {
        key: blacklistToggleKey,
      });
      showResult($("device-result"), `${data.message}. Updated rows: ${data.changed}`);
      await loadAllKeys();
    } catch (error) {
      showResult($("device-result"), error.message, true);
    }
    return;
  }

  if (deleteKey) {
    const confirmed = window.confirm(`Remove ${deleteKey}? This also removes its device bindings.`);
    if (!confirmed) return;

    try {
      await api("/api/delete-key", { key: deleteKey });
      await loadAllKeys();
    } catch (error) {
      alert(error.message);
    }
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  const snippetId = button.dataset.copySnippet;
  const outputId = button.dataset.copyOutput;
  if (!snippetId && !outputId) return;

  const snippet = $(snippetId || outputId).textContent;
  try {
    await copyText(snippet);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 900);
  } catch (error) {
    alert(error.message);
  }
});

renderIntegrationSnippets();

if (adminToken) {
  $("admin-token").value = adminToken;
  loadAllKeys()
    .then(() => show("dashboard"))
    .catch(() => {
      sessionStorage.removeItem("keySystemAdminToken");
      show("login");
    });
} else {
  show("login");
}
