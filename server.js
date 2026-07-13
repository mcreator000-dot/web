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
      notes TEXT NOT NULL DEFAULT ''
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS key_devices (
      id ${USE_POSTGRES ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT"},
      key_id INTEGER NOT NULL,
      device_hash TEXT NOT NULL,
      user_id TEXT,
      activated_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_validated_at ${USE_POSTGRES ? "TIMESTAMPTZ" : "TEXT"} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      validation_count INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(key_id, device_hash),
      FOREIGN KEY(key_id) REFERENCES license_keys(id) ON DELETE CASCADE
    )
  `);
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

function hashDeviceId(deviceId) {
  return crypto
    .createHmac("sha256", DEVICE_HASH_SECRET)
    .update(deviceId)
    .digest("hex");
}

function generateKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups = [];

  for (let group = 0; group < 4; group += 1) {
    let part = "";
    for (let index = 0; index < 4; index += 1) {
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
  const expiresAt = expiresInDays > 0
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const keyCode = generateKey();
    try {
      await run(
        `INSERT INTO license_keys (key_code, expires_at, max_devices, notes)
         VALUES (?, ?, ?, ?)`,
        [keyCode, expiresAt, maxDevices, notes]
      );
      await logUsage({
        keyCode,
        ip: req.ip,
        action: "KEY_GENERATED",
        details: JSON.stringify({ maxDevices, expiresAt }),
      });
      return res.json({ success: true, key: keyCode, expiresAt, maxUses: maxDevices });
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

  if (!keyCode || !deviceId) {
    return jsonError(res, 400, "Missing key or device ID", "missing_fields");
  }

  const deviceHash = hashDeviceId(deviceId);
  const ip = req.ip;

  const blacklisted = await get("SELECT id FROM device_blacklist WHERE device_hash = ?", [deviceHash]);
  if (blacklisted) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "BLACKLISTED_DEVICE" });
    return jsonError(res, 403, "This device is blacklisted", "blacklisted");
  }

  const keyRow = await get("SELECT * FROM license_keys WHERE key_code = ?", [keyCode]);
  if (!keyRow) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "INVALID_KEY" });
    return jsonError(res, 404, "Invalid key", "invalid");
  }

  if (!keyRow.is_active) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "INACTIVE_KEY" });
    return jsonError(res, 403, "Key is inactive", "inactive");
  }

  if (isExpired(keyRow)) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "EXPIRED_KEY" });
    return jsonError(res, 403, "Key has expired", "expired");
  }

  const activation = await get(
    "SELECT * FROM key_devices WHERE key_id = ? AND device_hash = ? AND active = 1",
    [keyRow.id, deviceHash]
  );

  if (activation) {
    await run(
      `UPDATE key_devices
       SET user_id = COALESCE(?, user_id),
           last_validated_at = CURRENT_TIMESTAMP,
           validation_count = validation_count + 1
       WHERE id = ?`,
      [userId, activation.id]
    );
    await logUsage({ keyCode, deviceHash, userId, ip, action: "KEY_VALIDATED" });
    return res.json({
      success: true,
      message: "Key validated successfully",
      status: "validated",
      isNew: false,
    });
  }

  const activeDeviceCount = await getActiveDeviceCount(keyRow.id);
  if (activeDeviceCount >= keyRow.max_devices) {
    await logUsage({ keyCode, deviceHash, userId, ip, action: "MAX_DEVICES_REACHED" });
    return jsonError(res, 403, "Key device limit reached", "max_uses");
  }

  await run(
    `INSERT INTO key_devices (key_id, device_hash, user_id)
     VALUES (?, ?, ?)
     ON CONFLICT(key_id, device_hash)
     DO UPDATE SET active = 1,
                   user_id = excluded.user_id,
                   last_validated_at = CURRENT_TIMESTAMP,
                   validation_count = key_devices.validation_count + 1`,
    [keyRow.id, deviceHash, userId]
  );
  await logUsage({ keyCode, deviceHash, userId, ip, action: "KEY_ACTIVATED" });
  return res.json({
    success: true,
    message: "Key activated successfully",
    status: "activated",
    isNew: true,
  });
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

app.post("/api/key-info", requireAdmin, asyncHandler(async (req, res) => {
  const keyCode = normalizeKey(req.body.key);

  if (!keyCode) {
    return jsonError(res, 400, "Missing key", "missing_key");
  }

  const keyRow = await get(
    `SELECT lk.*,
            SUM(CASE WHEN kd.active = 1 THEN 1 ELSE 0 END) AS used_count
     FROM license_keys lk
     LEFT JOIN key_devices kd ON kd.key_id = lk.id
     WHERE lk.key_code = ?
     GROUP BY lk.id`,
    [keyCode]
  );

  if (!keyRow) {
    return jsonError(res, 404, "Key not found", "not_found");
  }

  const devices = await all(
    `SELECT user_id, activated_at, last_validated_at, validation_count, active
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
           SUM(CASE WHEN kd.active = 1 THEN 1 ELSE 0 END) AS used_count
    FROM license_keys lk
    LEFT JOIN key_devices kd ON kd.key_id = lk.id
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

function formatKeyRow(row) {
  return {
    id: row.id,
    key: row.key_code,
    created_at: row.created_at,
    expires_at: row.expires_at,
    is_active: Boolean(row.is_active),
    max_uses: row.max_devices,
    max_devices: row.max_devices,
    used_count: row.used_count || 0,
    notes: row.notes || "",
    expired: isExpired(row),
  };
}

app.use((err, _req, res, _next) => {
  console.error(err);
  return jsonError(res, 500, "Internal server error", "server_error");
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
