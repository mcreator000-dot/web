# Key System

Node.js and Express license-key backend with a small admin dashboard and a two-step loader flow.

It uses SQLite for local development. On Vercel, set `DATABASE_URL` and it will use Postgres instead.

This service validates licenses, binds them to device identifiers, signs its validation responses, sweeps abandoned burner keys, and can return the script content attached to a key through the loader endpoint.

## Setup

```bash
cd key-system
npm install
Copy-Item .env.example .env
```

Edit `.env` and set long random values for `ADMIN_TOKEN`, `DEVICE_HASH_SECRET`, and `KEY_RESPONSE_SIGNING_SECRET`.

## Run

```bash
npm start
```

Open `http://localhost:3000` and log in with your `ADMIN_TOKEN`.

## Deploy To Vercel

Vercel serverless functions do not keep a local SQLite database between deployments or function runs, so production needs an external Postgres database. The easiest path is the Neon Postgres integration from the Vercel Marketplace.

1. Push or upload the `key-system` folder as the project root.
2. In Vercel, create/import the project.
3. Add a Postgres database integration, then make sure `DATABASE_URL` is available to the project.
4. Add these Environment Variables in Vercel:

```text
ADMIN_TOKEN=replace-with-a-long-random-admin-token
GHOST_T_ADMIN_TOKEN=replace-with-a-long-random-ghost-t-admin-token
DP_ADMIN_TOKEN=replace-with-a-long-random-dp-admin-token
DISCORD_BOT_API_TOKEN=
PAYMENT_PROVIDER=manual
PURCHASE_ORDER_SECRET=replace-with-a-long-random-purchase-order-secret
ELDORADO_API_KEY=
DEVICE_HASH_SECRET=replace-with-a-long-random-device-secret
KEY_RESPONSE_SIGNING_SECRET=replace-with-a-different-long-random-secret
KEY_SIG_STRICT=0
BURNER_INACTIVE_DAYS=3
AUTO_DELETE_STALE_BURNERS=true
STALE_SWEEP_INTERVAL_MS=1800000
CORS_ORIGIN=https://your-project.vercel.app
PUBLIC_BASE_URL=https://your-project.vercel.app
DEFAULT_SCRIPT_URL=https://your-domain.example/main.lua
GHOST_T_SCRIPT_URL=https://your-domain.example/ghost-t.lua
DP_SCRIPT_URL=https://your-domain.example/dp.lua
SCRIPT_URL_ALLOWLIST=your-domain.example
ALLOW_INSECURE_SCRIPT_URLS=false
MAX_SCRIPT_BYTES=5242880
AUTO_DELETE_EXPIRED_KEYS=true
DATABASE_URL=postgres://...
PGSSLMODE=require
```

5. Deploy the project.

The admin dashboard will be at your Vercel URL, and API routes stay the same, such as `/api/health`, `/api/generate-key`, `/api/validate-key`, and `/api/loader`.

### Vercel CLI

```bash
cd key-system
npm install
npx vercel
npx vercel env add ADMIN_TOKEN production
npx vercel env add GHOST_T_ADMIN_TOKEN production
npx vercel env add DP_ADMIN_TOKEN production
npx vercel env add DISCORD_BOT_API_TOKEN production
npx vercel env add PAYMENT_PROVIDER production
npx vercel env add PURCHASE_ORDER_SECRET production
npx vercel env add DEVICE_HASH_SECRET production
npx vercel env add KEY_RESPONSE_SIGNING_SECRET production
npx vercel env add KEY_SIG_STRICT production
npx vercel env add BURNER_INACTIVE_DAYS production
npx vercel env add AUTO_DELETE_STALE_BURNERS production
npx vercel env add STALE_SWEEP_INTERVAL_MS production
npx vercel env add CORS_ORIGIN production
npx vercel env add PUBLIC_BASE_URL production
npx vercel env add DEFAULT_SCRIPT_URL production
npx vercel env add GHOST_T_SCRIPT_URL production
npx vercel env add DP_SCRIPT_URL production
npx vercel env add SCRIPT_URL_ALLOWLIST production
npx vercel env add AUTO_DELETE_EXPIRED_KEYS production
npx vercel env add DATABASE_URL production
npx vercel env add PGSSLMODE production
npx vercel --prod
```

### Generating secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

PowerShell equivalent:

```powershell
[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
```

## API

Admin endpoints accept the token in either the `X-Admin-Token` header or the legacy `adminToken` JSON body field.
Logging in with `GHOST_T_ADMIN_TOKEN` opens a separate Ghost T dashboard. Logging in with `DP_ADMIN_TOKEN` opens a separate DP dashboard. Ghost T keys are stored with `product: "ghost_t"` and DP keys are stored with `product: "dp"`; each dashboard only shows its own keys.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/generate-key` | Create a new key and return its loadstring |
| `POST /api/validate-key` | Validate or activate a key for a device, returning a signed response |
| `GET /api/loader` | Return the Lua loader used by generated loadstrings |
| `POST /api/loader` | Validate a key/device and return raw attached script content |
| `POST /api/reset-hwid` | Reset a key binding, optionally for one device |
| `POST /api/blacklist-hwid` | Blacklist a device ID |
| `POST /api/unblacklist-hwid` | Remove a device ID from the blacklist |
| `POST /api/key-info` | Read one key and its activations |
| `POST /api/all-keys` | List all keys |
| `POST /api/update-notes` | Update notes on an existing key |
| `POST /api/toggle-key` | Enable or disable a key |
| `POST /api/delete-key` | Delete a key and its device bindings |
| `POST /api/discord/get-key` | Generate a key for a Discord role plan |
| `POST /api/discord/redeem-key` | Redeem and bind a key to a device |
| `POST /api/discord/reset-hwid` | Reset a key binding from the Discord bot |
| `POST /api/discord/get-script` | Return a key's loader URL and loadstring |

## Validation Request

Use a device identifier that your own app is allowed to collect. The backend stores only an HMAC hash of that identifier.

```json
{
  "key": "KEY-ABCD-EFGH-JKLM-NPQR",
  "deviceId": "your-device-id",
  "userId": "optional-user-id",
  "nonce": "optional-client-challenge"
}
```

Successful responses return `status: "activated"` for a first use on a device and `status: "validated"` for later checks.

## Signed Validation Responses

`POST /api/validate-key` signs its success payload so a client can prove the reply came from this server and was produced for the request it actually sent. Without this, a tampered client only has to fake `{"success":true}` to bypass a client-side gate.

Signed responses add `sig` and echo `nonce`, `deviceHash`, `product`, and `expiresAfterHours`.

### The canonical string is a contract

`sig` is `HMAC-SHA256(KEY_RESPONSE_SIGNING_SECRET, canonical)` in lowercase hex, where `canonical` is these fields joined by `|` in exactly this order:

```text
v1|<success as "true"/"false">|<nonce>|<deviceHash>|<product>|<status>|<expiresAt>|<serverTime>
```

Empty/absent values become empty strings. Example:

```text
v1|true|abc123|9f2c...|default|validated|2026-11-01T00:00:00.000Z|2026-10-08T10:00:00.000Z
```

If you change the order, the field set, or the `v1` prefix here, you must change it in the Lua client's `_SEC.canonical()` in the same release. A mismatch makes every legitimate validation fail.

### The client must be told the same secret

A client can only verify a signature if it holds the same secret. The Lua client reads it at
runtime, before the protected script runs:

```lua
getgenv().GHOST_KEY_SIGNING_SECRET = "<the same value as KEY_RESPONSE_SIGNING_SECRET>"
```

Behaviour, and why it is shaped this way:

| Server | Client | Outcome |
| --- | --- | --- |
| No secret set | anything | Unsigned response, allowed, client warns |
| Signed | `GHOST_KEY_SIGNING_SECRET` matches | Verified, allowed |
| Signed | secret missing or different | **Allowed with a warning** — never a lockout |
| Signed | signature does not match the body | **Rejected** |

An earlier iteration returned a hard failure when the secret was missing or different. That locked
every user out with `Key server response failed verification` the moment the server was configured
and the client was not, so mismatches now warn and pass while genuine tampering still fails.

Be clear about the ceiling: the value above ships inside the client, so a determined reverser can
extract it and then mint valid-looking responses. Client-side verification stops naive response
injection (the classic `return {Body='{"success":true}'}` hook) and nothing more. The boundary that
does not depend on the client is server-side enforcement — `/api/loader` re-validating the key on
every fetch — plus the obfuscation of the delivered script.

Verify a real response with plain Node:

```bash
node -e '
const crypto=require("crypto"),secret=process.env.KEY_RESPONSE_SIGNING_SECRET;
const d=JSON.parse(process.argv[1]);
const canon=["v1",d.success===true?"true":"false",String(d.nonce||""),String(d.deviceHash||""),
  String(d.product||""),String(d.status||""),String(d.expiresAt||""),String(d.serverTime||"")].join("|");
console.log("expected:",crypto.createHmac("sha256",secret).update(canon).digest("hex"));
console.log("received:",d.sig);
' "$(curl -s -X POST https://your-project.vercel.app/api/validate-key \
  -H 'Content-Type: application/json' \
  -d '{\"key\":\"KEY-...\",\"deviceId\":\"dev\",\"nonce\":\"abc123\"}')"
```

### Anti-replay

The client sends a random `nonce`; the server echoes it inside the signed payload and remembers it for 5 minutes. A replayed request is rejected with HTTP 409 `replayed`. A response captured for one request therefore cannot be replayed to another.

### Rollout: do not enable strict mode first

`KEY_RESPONSE_SIGNING_SECRET` is required before signature checking does anything.

- No secret set: responses are **unsigned**, the server logs a warning, and clients still work. The client warns `key server sent an UNSIGNED response - deploy the signing patch`.
- Secret set: responses are signed and clients verify them.
- `KEY_SIG_STRICT=1`: a missing secret becomes a hard HTTP 500 instead of a silent unsigned fallback. Enable this only **after** every deployed client verifies signatures, otherwise older or un-updated clients break.

Rotating `KEY_RESPONSE_SIGNING_SECRET` invalidates any client build whose secret has been extracted, but you must ship an updated client in the same window.

## Burner Key Cleanup

Time-limited keys that stop being **executed** are deleted automatically. Lifetime keys are never touched by this sweep.

- A "burner" is any key that is not lifetime, i.e. `expires_after_hours` is set. That column is the exact discriminator: `POST /api/generate-key` writes `null` for `expiresInUnit: "lifetime"`, and `getDiscordPlanDuration()` maps the lifetime plan to `null`, so every lifetime key stores `NULL` there.
- "Inactive" means not executed within the window. Activity is `MAX(key_devices.last_validated_at)`, which `/api/loader` and `/api/validate-key` both bump on every run.
- A key that was generated but never activated has no device row at all, so it ages out from `created_at` after the same window.
- Paused keys (`paused_at` set) are excluded, so pausing a licence never deletes it.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BURNER_INACTIVE_DAYS` | `3` | Grace period with no execution before a burner is removed |
| `AUTO_DELETE_STALE_BURNERS` | `true` | Set to `false` to disable the sweep entirely |
| `STALE_SWEEP_INTERVAL_MS` | `1800000` | Minimum gap between sweeps (30 min). The sweep runs inside the existing request path, so no cron is needed on Vercel |

Do **not** add an `expires_at IS NOT NULL` condition to this query. `expires_at` is `NULL` for every key until first activation, so requiring it silently disables removal of never-used burners.

## Loader Flow

Generate a key in the dashboard with a script URL. The API response includes a loadstring like:

```lua
script_key="KEY-ABCD-EFGH-JKLM-NPQR"; loadstring(game:HttpGet("https://your-project.vercel.app/api/loader", true))()
```

The loadstring downloads the Lua loader from `GET /api/loader`. The loader posts the key and device ID back to `POST /api/loader`; only after validation succeeds does the server fetch the key's `script_url` and return the raw script content. Errors still return JSON messages so the loader can show a useful failure reason.

For large obfuscated scripts, the loader tries a file-backed execution path first (`writefile` + `loadfile`) when the executor supports it, then falls back to `loadstring`.

Because the loader re-validates on every fetch, the server is the real enforcement point. Client-side checks are defence in depth, not the gate.

The dashboard shows execution IPs from active device bindings. `activation_ip` is the first IP that bound the key to that device, and `last_ip` is updated each time the key validates or the loader returns script content. IP changes are tracked for audit visibility but do not invalidate an already-bound device.

### Script size limit

`MAX_SCRIPT_BYTES` defaults to 5 MiB and is enforced when the loader fetches your script. A heavily obfuscated Lua script grows a lot (Luraph-style virtualisation commonly lands at 3-8x the source size), so raise this before shipping an obfuscated build, for example:

```text
MAX_SCRIPT_BYTES=12582912
```

If the script exceeds the limit the loader refuses to serve it, which looks like a key problem rather than a size problem. Check the obfuscated artifact's byte size before publishing.

`POST /api/generate-key` accepts:

```json
{
  "expiresIn": 30,
  "expiresInUnit": "days",
  "maxUses": 1,
  "scriptUrl": "https://your-domain.example/main.lua",
  "notes": "optional"
}
```

Use `"expiresInUnit": "hours"` for hourly keys or `"expiresInUnit": "lifetime"` for keys that never expire. Expired keys with an `expiresAt` value are automatically removed before API requests when `AUTO_DELETE_EXPIRED_KEYS` is not set to `false`; lifetime keys have no expiration and are kept.

Use scripts and script URLs you control. Keep admin tokens in environment variables only, and do not put secrets in distributed clients.

## Discord Bot API

Discord bot endpoints require either `X-Discord-Bot-Token: <DISCORD_BOT_API_TOKEN>` or `Authorization: Bearer <DISCORD_BOT_API_TOKEN>`. Use a separate Discord bot token instead of a dashboard admin token so the bot host does not have full dashboard access.

Purchase requests, redeemed-order protection, Discord channel settings, and panel message IDs are stored in Postgres. Use `PAYMENT_PROVIDER=manual` for private administrator approval. The Eldorado provider adapter is isolated in `verifyPurchaseOrder` and remains disabled until an approved API key and its API contract are available.

Use separate Discord API paths for each dashboard:

| Dashboard | Product | Auth token accepted | Endpoints |
| --- | --- | --- | --- |
| GhostLua | `default` | `DISCORD_BOT_API_TOKEN` | `/api/discord/ghostlua/get-key`, `/api/discord/ghostlua/redeem-key`, `/api/discord/ghostlua/reset-hwid`, `/api/discord/ghostlua/get-script`, `/api/discord/ghostlua/lookup-key`, `/api/discord/ghostlua/list-keys`, `/api/discord/ghostlua/toggle-key`, `/api/discord/ghostlua/delete-key` |
| Ghost T | `ghost_t` | `DISCORD_BOT_API_TOKEN` | `/api/discord/ghost-t/get-key`, `/api/discord/ghost-t/redeem-key`, `/api/discord/ghost-t/reset-hwid`, `/api/discord/ghost-t/get-script`, `/api/discord/ghost-t/lookup-key`, `/api/discord/ghost-t/list-keys`, `/api/discord/ghost-t/toggle-key`, `/api/discord/ghost-t/delete-key` |
| DP | `dp` | `DISCORD_BOT_API_TOKEN` | `/api/discord/dp/get-key`, `/api/discord/dp/redeem-key`, `/api/discord/dp/reset-hwid`, `/api/discord/dp/get-script`, `/api/discord/dp/lookup-key`, `/api/discord/dp/list-keys`, `/api/discord/dp/toggle-key`, `/api/discord/dp/delete-key` |

The generic `/api/discord/get-key`, `/api/discord/redeem-key`, `/api/discord/reset-hwid`, `/api/discord/get-script`, `/api/discord/lookup-key`, `/api/discord/list-keys`, `/api/discord/toggle-key`, and `/api/discord/delete-key` endpoints still work when you pass `"product": "ghost_t"`, `"product": "dp"`, or `"product": "default"`, but bots should prefer the dashboard-specific paths above.

`POST /api/discord/get-key` creates a key based on the user's role. Send one role/plan or a full role list from Discord. If multiple supported roles are present, the server picks the best one in this order: `lifetime`, `3months`, `month`, `week`.

```json
{
  "discordUserId": "123456789",
  "roles": ["member", "month"],
  "product": "ghost_t",
  "maxDevices": 1
}
```

Supported role names/aliases:

| Role plan | Key duration |
| --- | --- |
| `(w)-week`, `w`, `week`, `weekly`, `1week` | 7 days |
| `(m)-month`, `m`, `month`, `monthly`, `1month` | 30 days |
| `(3m)-3 months`, `3m`, `3months`, `3month`, `threemonths`, `90days` | 90 days |
| `(Lt)-life time`, `lt`, `lifetime`, `life`, `forever` | Never expires |

Successful responses include `key`, `loadstring`, `scriptUrl`, `expiresAfterHours`, `plan`, `sourceRole`, and `discordAccess`.

The Discord bot flow should be:

1. A moderator gives the buyer one time role: `(w)-week`, `(m)-month`, `(3m)-3 months`, or `(Lt)-life time`.
2. When the user presses Get Key, the bot sends the member's roles to the matching dashboard API.
3. The API creates the key duration from the highest role found and returns the loadstring.
4. When the user redeems the key, the API returns `discordAccess.grantRole: "private user"` and `discordAccess.hideRedeemButton: true`.
5. The bot should grant `private user`, hide or disable the Redeem button for that user, and schedule removal of both `discordAccess.sourceRole` and `private user` at `discordAccess.removePrivateUserRoleAt`.
6. Get Script should copy or DM only the returned `loadstring`.

`POST /api/discord/redeem-key` validates and binds a key to a device/HWID:

```json
{
  "key": "KEY-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "hwid": "device-id-from-client",
  "discordUserId": "123456789",
  "product": "ghost_t"
}
```

`POST /api/discord/reset-hwid` resets all active device bindings for a key when `hwid` is blank, or only one binding when `hwid` is supplied.

```json
{
  "key": "KEY-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "hwid": "optional-device-id",
  "discordUserId": "admin-discord-id",
  "product": "ghost_t"
}
```

`POST /api/discord/get-script` returns the loader URL and ready-to-send loadstring for a valid active key:

```json
{
  "key": "KEY-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "product": "ghost_t"
}
```

`POST /api/discord/list-keys` returns recent keys for the selected product:

```json
{
  "limit": 10,
  "product": "dp"
}
```

`POST /api/discord/lookup-key` returns one key and its device bindings:

```json
{
  "key": "KEY-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "product": "dp"
}
```

`POST /api/discord/toggle-key` enables or disables a key:

```json
{
  "key": "KEY-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "isActive": false,
  "discordUserId": "admin-discord-id",
  "product": "dp"
}
```

`POST /api/discord/delete-key` permanently deletes a key and requires confirmation:

```json
{
  "key": "KEY-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "confirm": true,
  "discordUserId": "admin-discord-id",
  "product": "dp"
}
```

## Security Notes

- Production refuses to start with the development `ADMIN_TOKEN`, `GHOST_T_ADMIN_TOKEN`, `DP_ADMIN_TOKEN`, missing `DISCORD_BOT_API_TOKEN`, or `DEVICE_HASH_SECRET`.
- Generated keys use 25 random characters split across five groups.
- Protected script URLs must use HTTPS unless they are localhost or `ALLOW_INSECURE_SCRIPT_URLS=true`.
- Set `SCRIPT_URL_ALLOWLIST` to a comma-separated list of allowed script hostnames so new keys cannot point at arbitrary domains.
- Loader and script responses are marked `Cache-Control: no-store`.
- The server stores HMAC hashes of device IDs, not raw device IDs.
- Validation responses are HMAC-signed and nonce-bound. See [Signed Validation Responses](#signed-validation-responses).
- `KEY_RESPONSE_SIGNING_SECRET` must differ from `DEVICE_HASH_SECRET`. The server falls back to `DEVICE_HASH_SECRET` only so a fresh deployment works; set a separate value.
- Every `/api/validate-key` request is rate limited to 60 per minute per IP, and `/api` admin routes to 120 per minute.
- Never commit `.env`. It is git-ignored, but confirm before pushing.

### What this design does and does not guarantee

Server-side enforcement is the real gate: `/api/loader` re-validates the key on every fetch, so a patched client still cannot obtain the script without a valid, active, device-bound key.

Client-side hardening (obfuscation, signed-response verification, integrity checks) raises the cost of cracking a delivered client but cannot make it impossible. A determined reverser controls the execution environment and can instrument any code handed to it. Treat client protections as defence in depth, and keep anything that must stay secret on the server.

Finally: a hostile client can inspect any script that is delivered to it. Obfuscation, server-side checks, and fast revocation help, but no client-delivered Lua can be made impossible to copy.
