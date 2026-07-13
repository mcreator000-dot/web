require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-admin-token";
const DEVICE_HASH_SECRET = process.env.DEVICE_HASH_SECRET || "dev-device-secret";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DEFAULT_SCRIPT_URL = process.env.DEFAULT_SCRIPT_URL || "";
const MAX_SCRIPT_BYTES = Number(process.env.MAX_SCRIPT_BYTES || 5 * 1024 * 1024);
const SCRIPT_URL_ALLOWLIST = String(process.env.SCRIPT_URL_ALLOWLIST || "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const ALLOW_INSECURE_SCRIPT_URLS = process.env.ALLOW_INSECURE_SCRIPT_URLS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
const USE_POSTGRES = Boolean(DATABASE_URL);
let dbReady;
let sqliteDb;
let pgPool;

if (ADMIN_TOKEN === "dev-admin-token") {
  console.warn("ADMIN_TOKEN is not set. Using development token: dev-admin-token");
}

if (DEVICE_HASH_SECRET === "dev-device-secret") {
  console.warn("DEVICE_HASH_SECRET is not set. Set it before production use.");
}

function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;

  const failures = [];
  if (ADMIN_TOKEN === "dev-admin-token") failures.push("ADMIN_TOKEN");
  if (DEVICE_HASH_SECRET === "dev-device-secret") failures.push("DEVICE_HASH_SECRET");
  if (!process.env.PUBLIC_BASE_URL && !process.env.VERCEL_PROJECT_PRODUCTION_URL) failures.push("PUBLIC_BASE_URL");

  if (failures.length) {
    throw new Error(`Production configuration is missing secure values for: ${failures.join(", ")}`);
  }
}

assertProductionConfig();

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/validate-key", validateLimiter);
app.use("/api/loader", validateLimiter);
app.use("/api", adminLimiter);

if (USE_POSTGRES) {
  const { Pool } = require("pg");
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
  });
} else {
  const sqlite3 = require("sqlite3").verbose();
  sqliteDb = new sqlite3.Database(path.join(__dirname, "keys.db"));
}

function toPostgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function run(sql, params = []) {
  if (USE_POSTGRES) {
    return pgPool.query(toPostgresSql(sql), params).then((result) => ({
      changes: result.rowCount,
      lastID: result.rows && result.rows[0] ? result.rows[0].id : undefined,
    }));
  }

  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  if (USE_POSTGRES) {
    return pgPool.query(toPostgresSql(sql), params).then((result) => result.rows[0] || null);
  }

  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  if (USE_POSTGRES) {
    return pgPool.query(toPostgresSql(sql), params).then((result) => result.rows);
  }

  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDatabase() {
  if (!USE_POSTGRES) {
    await run("PRAGMA foreign_keys = ON");
  }

  await run(`
    CREATE TABLE IF NOT EXISTS license_keys (
      id ${USE_POSTGRES ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      key_code TEXT UNIQUE NOT NULL,
      created_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"},
      is_active INTEGER NOT NULL DEFAULT 1,
      max_devices INTEGER NOT NULL DEFAULT 1,
      script_url TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT ''
    )
  `);
  await ensureColumn("license_keys", "script_url", "TEXT NOT NULL DEFAULT ''");
  await run(`
    CREATE TABLE IF NOT EXISTS key_devices (
      id ${USE_POSTGRES ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      key_id INTEGER NOT NULL,
      device_hash TEXT NOT NULL,
      user_id TEXT,
      activated_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_validated_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      activation_ip TEXT,
      last_ip TEXT,
      validation_count INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(key_id, device_hash),
      FOREIGN KEY(key_id) REFERENCES license_keys(id) ON DELETE CASCADE
    )
  `);
  await ensureColumn("key_devices", "activation_ip", "TEXT");
  await ensureColumn("key_devices", "last_ip", "TEXT");
  await run(`
    CREATE TABLE IF NOT EXISTS device_blacklist (
      id ${USE_POSTGRES ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      device_hash TEXT UNIQUE NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      banned_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id ${USE_POSTGRES ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      key_code TEXT,
      device_hash TEXT,
      user_id TEXT,
      ip TEXT,
      action TEXT NOT NULL,
      details TEXT,
      timestamp ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function ensureColumn(tableName, columnName, definition) {
  if (USE_POSTGRES) {
    const column = await get(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = ? AND column_name = ?`,
      [tableName, columnName]
    );

    if (!column) {
      await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
    return;
  }

  const columns = await all(`PRAGMA table_info(${tableName})`);
  if (!columns.some((column) => column.name === columnName)) {
    await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function jsonError(res, status, message, code = "error") {
  return res.status(status).json({ success: false, message, error: message, status: code });
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res, next) {
  const suppliedToken = req.get("x-admin-token") || req.body.adminToken;
  if (!timingSafeEqual(suppliedToken, ADMIN_TOKEN)) {
    return jsonError(res, 403, "Unauthorized", "unauthorized");
  }
  return next();
}

function normalizeKey(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDeviceId(req) {
  return String(req.body.deviceId || req.body.hwid || "").trim();
}

function isLocalHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function getPublicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (configured) {
    return configured.startsWith("http") ? configured.replace(/\/+$/, "") : `https://${configured.replace(/\/+$/, "")}`;
  }
  return `${req.protocol}://${req.get("host")}`;
}

function normalizeScriptUrl(value) {
  const scriptUrl = String(value || DEFAULT_SCRIPT_URL || "").trim();
  if (!scriptUrl) return "";

  let parsed;
  try {
    parsed = new URL(scriptUrl);
  } catch (_error) {
    throw Object.assign(new Error("Script URL must be a valid URL"), { statusCode: 400, status: "invalid_script_url" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("Script URL must use http or https"), { statusCode: 400, status: "invalid_script_url" });
  }

  if (parsed.protocol !== "https:" && !ALLOW_INSECURE_SCRIPT_URLS && !isLocalHostname(parsed.hostname)) {
    throw Object.assign(new Error("Script URL must use https"), { statusCode: 400, status: "insecure_script_url" });
  }

  if (SCRIPT_URL_ALLOWLIST.length && !SCRIPT_URL_ALLOWLIST.includes(parsed.hostname.toLowerCase())) {
    throw Object.assign(new Error("Script URL host is not allowed"), { statusCode: 400, status: "script_host_not_allowed" });
  }

  return parsed.toString();
}

function buildLoadstring(baseUrl, keyCode) {
  const loaderUrl = `${baseUrl.replace(/\/+$/, "")}/api/loader`;
  return `script_key="${keyCode}"; loadstring(game:HttpGet("${loaderUrl}", true))()`;
}

function hashDeviceId(deviceId) {
  return crypto
    .createHmac("sha256", DEVICE_HASH_SECRET)
    .update(deviceId)
    .digest("hex");
}

function generateKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups = [];

  for (let group = 0; group < 5; group += 1) {
    let part = "";
    for (let index = 0; index < 5; index += 1) {
      part += chars[crypto.randomInt(chars.length)];
    }
    groups.push(part);
  }

  return `KEY-${groups.join("-")}`;
}

function isUniqueError(error) {
  const message = String(error && error.message ? error.message : "").toLowerCase();
  return error && (error.code === "23505" || message.includes("unique") || message.includes("duplicate"));
}

async function logUsage({ keyCode, deviceHash, userId, ip, action, details }) {
  await run(
    `INSERT INTO usage_logs (key_code, device_hash, user_id, ip, action, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [keyCode || null, deviceHash || null, userId || null, ip || null, action, details || null]
  );
}

async function getActiveDeviceCount(keyId) {
  const row = await get(
    "SELECT COUNT(*) AS count FROM key_devices WHERE key_id = ? AND active = 1",
    [keyId]
  );
  return row ? row.count : 0;
}

function isExpired(keyRow) {
  return keyRow.expires_at && Date.now() > new Date(keyRow.expires_at).getTime();
}

function executionIpsSelectSql() {
  if (USE_POSTGRES) {
    return "STRING_AGG(DISTINCT CASE WHEN kd.active = 1 THEN kd.last_ip ELSE NULL END, ',') AS execution_ips";
  }

  return "GROUP_CONCAT(DISTINCT CASE WHEN kd.active = 1 THEN kd.last_ip END) AS execution_ips";
}

function blacklistedDevicesSelectSql() {
  return "SUM(CASE WHEN dbl.id IS NOT NULL THEN 1 ELSE 0 END) AS blacklisted_count";
}

async function validateKeyForDevice({ keyCode, deviceId, userId, ip }) {
  if (!keyCode || !deviceId) {
    return { ok: false, status: 400, message: "Missing key or device ID", code: "missing_fields" };
  }

  const deviceHash = hashDeviceId(deviceId);
  const currentIp = ip ? String(ip) : null;

  const blacklisted = await get("SELECT id FROM device_blacklist WHERE device_hash = ?", [deviceHash]);
  if (blacklisted) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "BLACKLISTED_DEVICE" });
    return { ok: false, status: 403, message: "This device is blacklisted", code: "blacklisted" };
  }

  const keyRow = await get("SELECT * FROM license_keys WHERE key_code = ?", [keyCode]);
  if (!keyRow) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "INVALID_KEY" });
    return { ok: false, status: 404, message: "Invalid key", code: "invalid" };
  }

  if (!keyRow.is_active) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "INACTIVE_KEY" });
    return { ok: false, status: 403, message: "Key is inactive", code: "inactive" };
  }

  if (isExpired(keyRow)) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "EXPIRED_KEY" });
    return { ok: false, status: 403, message: "Key has expired", code: "expired" };
  }

  const activation = await get(
    "SELECT * FROM key_devices WHERE key_id = ? AND device_hash = ? AND active = 1",
    [keyRow.id, deviceHash]
  );

  if (activation) {
    const activationIp = activation.activation_ip ? String(activation.activation_ip) : null;
    if (activationIp && currentIp && activationIp !== currentIp) {
      await logUsage({
        keyCode,
        deviceHash,
        userId,
        ip,
        action: "IP_MISMATCH",
        details: JSON.stringify({ activationIp, currentIp }),
      });
      return { ok: false, status: 403, message: "Key is locked to another IP", code: "ip_mismatch" };
    }

    await run(
      `UPDATE key_devices
       SET user_id = COALESCE(?, user_id),
           activation_ip = COALESCE(activation_ip, ?),
           last_validated_at = CURRENT_TIMESTAMP,
           last_ip = ?,
           validation_count = validation_count + 1
       WHERE id = ?`,
      [userId, currentIp, currentIp, activation.id]
    );
    await logUsage({ keyCode, deviceHash, userId, ip, action: "KEY_VALIDATED" });
    return { ok: true, keyRow, deviceHash, statusText: "validated", isNew: false };
  }

  const activeDeviceCount = await getActiveDeviceCount(keyRow.id);
  if (activeDeviceCount >= keyRow.max_devices) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "MAX_DEVICES_REACHED" });
    return { ok: false, status: 403, message: "Key device limit reached", code: "max_uses" };
  }

  await run(
    `INSERT INTO key_devices (key_id, device_hash, user_id, activation_ip, last_ip)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key_id, device_hash)
     DO UPDATE SET active = 1,
                   user_id = excluded.user_id,
                   activation_ip = COALESCE(key_devices.activation_ip, excluded.activation_ip),
                   last_validated_at = CURRENT_TIMESTAMP,
                   last_ip = excluded.last_ip,
                   validation_count = key_devices.validation_count + 1`,
    [keyRow.id, deviceHash, userId, currentIp, currentIp]
  );
  await logUsage({ keyCode, deviceHash, userId, ip, action: "KEY_ACTIVATED" });
  return { ok: true, keyRow, deviceHash, statusText: "activated", isNew: true };
}

async function fetchScriptContent(scriptUrl) {
  const safeScriptUrl = normalizeScriptUrl(scriptUrl);
  if (!safeScriptUrl) {
    throw Object.assign(new Error("No script URL is configured for this key"), {
      statusCode: 500,
      status: "missing_script_url",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(safeScriptUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "key-system-loader/1.0" },
    });

    if (!response.ok) {
      throw Object.assign(new Error(`Script fetch failed with ${response.status}`), {
        statusCode: 502,
        status: "script_fetch_failed",
      });
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_SCRIPT_BYTES) {
      throw Object.assign(new Error("Script is too large"), {
        statusCode: 413,
        status: "script_too_large",
      });
    }

    const script = await response.text();
    if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) {
      throw Object.assign(new Error("Script is too large"), {
        statusCode: 413,
        status: "script_too_large",
      });
    }

    return script;
  } finally {
    clearTimeout(timeout);
  }
}

function buildLuaLoader(req) {
  const apiUrl = `${getPublicBaseUrl(req)}/api/loader`;
  return `-- Delta key loader
local API_URL = "${apiUrl}"
local MAX_RETRIES = 3
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

local function notify(title, text)
  pcall(function()
    game:GetService("StarterGui"):SetCore("SendNotification", {
      Title = title,
      Text = text,
      Duration = 5
    })
  end)
end

local function getDeviceId()
  if syn and syn.crypt and syn.crypt.hwid then
    local ok, value = pcall(syn.crypt.hwid)
    if ok and value then return tostring(value) end
  end

  local clientId = "unknown"
  pcall(function()
    clientId = game:GetService("RbxAnalyticsService"):GetClientId()
  end)

  local executor = "executor"
  pcall(function()
    if getexecutorname then
      executor = tostring(getexecutorname())
    end
  end)

  return executor .. "-" .. tostring(clientId)
end

local function request(requestData)
  local requester = (syn and syn.request) or http_request or request or (http and http.request)
  if requester then
    return requester(requestData)
  end

  return HttpService:RequestAsync(requestData)
end

local function validate()
  local key = script_key or _G.script_key or shared.script_key
  if not key or tostring(key) == "" then
    return false, "Missing script key"
  end

  local player = Players.LocalPlayer
  local body = HttpService:JSONEncode({
    key = tostring(key),
    hwid = getDeviceId(),
    userId = player and tostring(player.UserId) or nil
  })

  for attempt = 1, MAX_RETRIES do
    local ok, response = pcall(request, {
      Url = API_URL,
      Method = "POST",
      Headers = { ["Content-Type"] = "application/json" },
      Body = body
    })

    if ok and response then
      local statusCode = response.StatusCode or response.status_code or response.Status or 200
      local responseBody = response.Body or response.body or ""
      local decodedOk, decoded = pcall(function()
        return HttpService:JSONDecode(responseBody)
      end)

      if decodedOk and decoded then
        if decoded.success and decoded.script then
          return true, decoded.script
        end
        return false, decoded.message or decoded.error or "Key validation failed"
      end

      if statusCode >= 200 and statusCode < 300 and responseBody ~= "" then
        return true, responseBody
      end

      return false, "Invalid response from key server"
    end

    if attempt < MAX_RETRIES then
      task.wait(1)
    end
  end

  return false, "Could not reach key server"
end

local ok, result = validate()
if not ok then
  warn("[Delta Loader] " .. tostring(result))
  notify("Key validation failed", tostring(result))
  return
end

local function runScript(source)
  if loadfile and writefile then
    local folder = "DeltaKeySystem"
    local path = folder .. "/payload.lua"

    pcall(function()
      if makefolder and (not isfolder or not isfolder(folder)) then
        makefolder(folder)
      end
    end)

    local wrote = pcall(function()
      writefile(path, source)
    end)

    if wrote then
      local fileFn, fileErr = loadfile(path)
      if fileFn then
        return pcall(fileFn)
      end
      warn("[Delta Loader] loadfile failed: " .. tostring(fileErr))
    end
  end

  local fn, err = loadstring(source)
  if not fn then
    return false, err
  end

  return pcall(fn)
end

local ran, runErr = runScript(result)
if not ran then
  warn("[Delta Loader] " .. tostring(runErr))
  notify("Script error", tostring(runErr))
end
`;
}

app.use((req, res, next) => {
  if (req.path === "/api/health") {
    return next();
  }

  return Promise.resolve(dbReady).then(() => next()).catch(next);
});

app.get("/api/health", (_req, res) => {
  res.json({ success: true, status: "ok", database: USE_POSTGRES ? "postgres" : "sqlite" });
});

app.post("/api/generate-key", requireAdmin, asyncHandler(async (req, res) => {
  const expiresInDays = Number(req.body.expiresInDays || 0);
  const maxDevices = Math.max(1, Number(req.body.maxUses || req.body.maxDevices || 1));
  const notes = String(req.body.notes || "").slice(0, 500);
  const scriptUrl = normalizeScriptUrl(req.body.scriptUrl);
  if (!scriptUrl) {
    return jsonError(res, 400, "Missing script URL", "missing_script_url");
  }
  const expiresAt = expiresInDays > 0
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const keyCode = generateKey();
    try {
      await run(
        `INSERT INTO license_keys (key_code, expires_at, max_devices, script_url, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [keyCode, expiresAt, maxDevices, scriptUrl, notes]
      );
      await logUsage({
        keyCode,
        ip: req.ip,
        action: "KEY_GENERATED",
        details: JSON.stringify({ maxDevices, expiresAt, scriptUrl }),
      });
      return res.json({
        success: true,
        key: keyCode,
        expiresAt,
        maxUses: maxDevices,
        scriptUrl,
        loadstring: buildLoadstring(getPublicBaseUrl(req), keyCode),
      });
    } catch (error) {
      if (!isUniqueError(error)) throw error;
    }
  }

  return jsonError(res, 500, "Could not generate a unique key", "generation_failed");
}));

app.post("/api/validate-key", asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);
  const deviceId = normalizeDeviceId(req);
  const userId = req.body.userId ? String(req.body.userId).slice(0, 128) : null;
  const ip = req.ip;

  const result = await validateKeyForDevice({ keyCode, deviceId, userId, ip });
  if (!result.ok) {
    return jsonError(res, result.status, result.message, result.code);
  }

  return res.json({
    success: true,
    message: result.isNew ? "Key activated successfully" : "Key validated successfully",
    status: result.statusText,
    isNew: result.isNew,
  });
}));

app.get("/api/loader", (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  res.type("text/plain").send(buildLuaLoader(req));
});

app.post("/api/loader", asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);
  const deviceId = normalizeDeviceId(req);
  const userId = req.body.userId ? String(req.body.userId).slice(0, 128) : null;
  const result = await validateKeyForDevice({ keyCode, deviceId, userId, ip: req.ip });

  if (!result.ok) {
    return jsonError(res, result.status, result.message, result.code);
  }

  const script = await fetchScriptContent(result.keyRow.script_url);
  res.set("Cache-Control", "no-store, max-age=0");
  await logUsage({
    keyCode,
    deviceHash: result.deviceHash,
    userId,
    ip: req.ip,
    action: "SCRIPT_DELIVERED",
    details: JSON.stringify({ bytes: Buffer.byteLength(script, "utf8") }),
  });
  return res.type("text/plain").send(script);
}));

app.post(["/api/reset-hwid", "/api/reset-device"], requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);
  const deviceId = normalizeDeviceId(req);

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const keyRow = await get("SELECT * FROM license_keys WHERE key_code = ?", [keyCode]);
  if (!keyRow) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  let result;
  if (deviceId) {
    const deviceHash = hashDeviceId(deviceId);
    result = await run(
      "UPDATE key_devices SET active = 0 WHERE key_id = ? AND device_hash = ?",
      [keyRow.id, deviceHash]
    );
    await logUsage({ keyCode, deviceHash, ip: req.ip, action: "DEVICE_RESET" });
  } else {
    result = await run("UPDATE key_devices SET active = 0 WHERE key_id = ?", [keyRow.id]);
    await logUsage({ keyCode, ip: req.ip, action: "ALL_DEVICES_RESET" });
  }

  return res.json({
    success: true,
    message: "Device binding reset successfully",
    changed: result.changes,
  });
}));

app.post(["/api/blacklist-hwid", "/api/blacklist-device"], requireAdmin, asyncHandler(async (req, res) => {
  const deviceId = normalizeDeviceId(req);
  const reason = String(req.body.reason || "No reason provided").slice(0, 500);

  if (!deviceId) {
    return jsonError(res, 400, "Missing device ID", "missing_device");
  }

  const deviceHash = hashDeviceId(deviceId);
  await run(
    `INSERT INTO device_blacklist (device_hash, reason)
     VALUES (?, ?)
     ON CONFLICT(device_hash) DO UPDATE SET reason = excluded.reason,
                                            banned_at = CURRENT_TIMESTAMP`,
    [deviceHash, reason]
  );
  await run("UPDATE key_devices SET active = 0 WHERE device_hash = ?", [deviceHash]);
  await logUsage({ deviceHash, ip: req.ip, action: "DEVICE_BLACKLISTED", details: reason });

  return res.json({ success: true, message: "Device blacklisted successfully" });
}));

app.post(["/api/unblacklist-hwid", "/api/unblacklist-device"], requireAdmin, asyncHandler(async (req, res) => {
  const deviceId = normalizeDeviceId(req);

  if (!deviceId) {
    return jsonError(res, 400, "Missing device ID", "missing_device");
  }

  const deviceHash = hashDeviceId(deviceId);
  const result = await run("DELETE FROM device_blacklist WHERE device_hash = ?", [deviceHash]);
  await logUsage({ deviceHash, ip: req.ip, action: "DEVICE_UNBLACKLISTED" });

  return res.json({
    success: true,
    message: "Device removed from blacklist",
    changed: result.changes,
  });
}));

async function getKeyDevicesForAdmin(keyCode) {
  const keyRow = await get("SELECT * FROM license_keys WHERE key_code = ?", [keyCode]);
  if (!keyRow) {
    return { keyRow: null, devices: [] };
  }

  const devices = await all(
    "SELECT DISTINCT device_hash FROM key_devices WHERE key_id = ?",
    [keyRow.id]
  );

  return { keyRow, devices };
}

app.post("/api/blacklist-key-devices", requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);
  const reason = String(req.body.reason || `Blacklisted from key ${keyCode}`).slice(0, 500);

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const { keyRow, devices } = await getKeyDevicesForAdmin(keyCode);
  if (!keyRow) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  for (const device of devices) {
    await run(
      `INSERT INTO device_blacklist (device_hash, reason)
       VALUES (?, ?)
       ON CONFLICT(device_hash) DO UPDATE SET reason = excluded.reason,
                                              banned_at = CURRENT_TIMESTAMP`,
      [device.device_hash, reason]
    );
  }

  await run("UPDATE key_devices SET active = 0 WHERE key_id = ?", [keyRow.id]);
  await logUsage({
    keyCode,
    ip: req.ip,
    action: "KEY_DEVICES_BLACKLISTED",
    details: JSON.stringify({ count: devices.length, reason }),
  });

  return res.json({
    success: true,
    message: devices.length ? "Key devices blacklisted" : "No devices are bound to this key",
    changed: devices.length,
  });
}));

app.post("/api/unblacklist-key-devices", requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const { keyRow, devices } = await getKeyDevicesForAdmin(keyCode);
  if (!keyRow) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  let changed = 0;
  for (const device of devices) {
    const result = await run("DELETE FROM device_blacklist WHERE device_hash = ?", [device.device_hash]);
    changed += Number(result.changes || 0);
  }

  await logUsage({
    keyCode,
    ip: req.ip,
    action: "KEY_DEVICES_UNBLACKLISTED",
    details: JSON.stringify({ count: changed }),
  });

  return res.json({
    success: true,
    message: changed ? "Key devices unblacklisted" : "No blacklisted devices found for this key",
    changed,
  });
}));

app.post("/api/key-info", requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const keyRow = await get(
    `SELECT lk.*,
            SUM(CASE WHEN kd.active = 1 THEN 1 ELSE 0 END) AS used_count,
            ${executionIpsSelectSql()},
            ${blacklistedDevicesSelectSql()}
     FROM license_keys lk
     LEFT JOIN key_devices kd ON kd.key_id = lk.id
     LEFT JOIN device_blacklist dbl ON dbl.device_hash = kd.device_hash
     WHERE lk.key_code = ?
     GROUP BY lk.id`,
    [keyCode]
  );

  if (!keyRow) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  const devices = await all(
    `SELECT user_id, activated_at, last_validated_at, activation_ip, last_ip, validation_count, active
     FROM key_devices
     WHERE key_id = ?
     ORDER BY last_validated_at DESC`,
    [keyRow.id]
  );

  return res.json({
    success: true,
    data: formatKeyRow(keyRow),
    devices,
  });
}));

app.post("/api/all-keys", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await all(`
    SELECT lk.*,
           SUM(CASE WHEN kd.active = 1 THEN 1 ELSE 0 END) AS used_count,
           ${executionIpsSelectSql()},
           ${blacklistedDevicesSelectSql()}
    FROM license_keys lk
    LEFT JOIN key_devices kd ON kd.key_id = lk.id
    LEFT JOIN device_blacklist dbl ON dbl.device_hash = kd.device_hash
    GROUP BY lk.id
    ORDER BY lk.created_at DESC
  `);

  return res.json({ success: true, data: rows.map(formatKeyRow) });
}));

app.post("/api/toggle-key", requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);
  const isActive = req.body.isActive ? 1 : 0;

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const result = await run("UPDATE license_keys SET is_active = ? WHERE key_code = ?", [isActive, keyCode]);
  if (!result.changes) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  await logUsage({
    keyCode,
    ip: req.ip,
    action: isActive ? "KEY_ENABLED" : "KEY_DISABLED",
  });

  return res.json({ success: true, message: isActive ? "Key enabled" : "Key disabled" });
}));

app.post("/api/delete-key", requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const result = await run("DELETE FROM license_keys WHERE key_code = ?", [keyCode]);
  if (!result.changes) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  await logUsage({
    keyCode,
    ip: req.ip,
    action: "KEY_DELETED",
  });

  return res.json({ success: true, message: "Key deleted" });
}));

function formatKeyRow(row) {
  const executionIps = String(row.execution_ips || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  return {
    id: row.id,
    key: row.key_code,
    created_at: row.created_at,
    expires_at: row.expires_at,
    is_active: Boolean(row.is_active),
    max_uses: row.max_devices,
    max_devices: row.max_devices,
    used_count: row.used_count || 0,
    blacklisted_count: row.blacklisted_count || 0,
    execution_ips: executionIps,
    script_url: row.script_url || "",
    notes: row.notes || "",
    expired: isExpired(row),
  };
}

app.use((err, _req, res, _next) => {
  console.error(err);
  return jsonError(
    res,
    err.statusCode || 500,
    err.statusCode ? err.message : "Internal server error",
    err.status || "server_error"
  );
});

dbReady = initDatabase();

if (require.main === module) {
  dbReady.then(() => {
    app.listen(PORT, () => {
      console.log(`Key system running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
}

module.exports = app;
