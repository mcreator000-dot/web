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

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleDateString();
}

function getKeyStatus(key) {
  if (!key.is_active) return { label: "Inactive", className: "status-inactive" };
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
      String(key.notes || "").toLowerCase().includes(filter);
  });

  if (!filteredKeys.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="6">No keys found.</td>';
    table.appendChild(row);
    return;
  }

  for (const key of filteredKeys) {
    const status = getKeyStatus(key);
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><span class="key-code">${key.key}</span></td>
      <td><span class="status-pill ${status.className}">${status.label}</span></td>
      <td>${key.used_count}/${key.max_uses}</td>
      <td>${formatDate(key.expires_at)}</td>
      <td>${escapeHtml(key.notes || "")}</td>
      <td>
        <div class="row-actions">
          <button type="button" class="secondary" data-copy="${key.key}">Copy</button>
          <button type="button" class="${key.is_active ? "danger" : ""}" data-toggle="${key.key}" data-active="${key.is_active ? "0" : "1"}">
            ${key.is_active ? "Disable" : "Enable"}
          </button>
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
      expiresInDays: Number($("expires-in").value || 0),
      maxUses: Number($("max-uses").value || 1),
      notes: $("notes").value.trim(),
    });
    showResult(output, `Generated ${data.key} | Expires: ${formatDate(data.expiresAt)} | Max devices: ${data.maxUses}`);
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

$("blacklist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const output = $("device-result");

  try {
    const data = await api("/api/blacklist-hwid", {
      deviceId: $("blacklist-device").value.trim(),
      reason: $("blacklist-reason").value.trim(),
    });
    showResult(output, data.message);
    await loadAllKeys();
  } catch (error) {
    showResult(output, error.message, true);
  }
});

$("unblacklist-device").addEventListener("click", async () => {
  const output = $("device-result");

  try {
    const data = await api("/api/unblacklist-hwid", {
      deviceId: $("blacklist-device").value.trim(),
    });
    showResult(output, `${data.message}. Updated rows: ${data.changed}`);
  } catch (error) {
    showResult(output, error.message, true);
  }
});

$("key-filter").addEventListener("input", renderKeys);

$("keys-table").addEventListener("click", async (event) => {
  const copyKey = event.target.dataset.copy;
  const toggleKey = event.target.dataset.toggle;

  if (copyKey) {
    await navigator.clipboard.writeText(copyKey);
    event.target.textContent = "Copied";
    setTimeout(() => {
      event.target.textContent = "Copy";
    }, 900);
  }

  if (toggleKey) {
    try {
      await api("/api/toggle-key", {
        key: toggleKey,
        isActive: event.target.dataset.active === "1",
      });
      await loadAllKeys();
    } catch (error) {
      alert(error.message);
    }
  }
});

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
