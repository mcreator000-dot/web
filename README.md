# Key System

Node.js and Express license-key backend with a small admin dashboard and a two-step loader flow.

It uses SQLite for local development. On Vercel, set `DATABASE_URL` and it will use Postgres instead.

This service validates licenses, binds them to device identifiers, and can return the script content attached to a key through the loader endpoint.

## Setup

```bash
cd key-system
npm install
Copy-Item .env.example .env
```

Edit `.env` and set long random values for `ADMIN_TOKEN` and `DEVICE_HASH_SECRET`.

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
DEVICE_HASH_SECRET=replace-with-a-long-random-device-secret
CORS_ORIGIN=https://your-project.vercel.app
PUBLIC_BASE_URL=https://your-project.vercel.app
DEFAULT_SCRIPT_URL=https://your-domain.example/main.lua
SCRIPT_URL_ALLOWLIST=your-domain.example
ALLOW_INSECURE_SCRIPT_URLS=false
MAX_SCRIPT_BYTES=5242880
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
npx vercel env add DEVICE_HASH_SECRET production
npx vercel env add CORS_ORIGIN production
npx vercel env add PUBLIC_BASE_URL production
npx vercel env add DEFAULT_SCRIPT_URL production
npx vercel env add SCRIPT_URL_ALLOWLIST production
npx vercel env add DATABASE_URL production
npx vercel env add PGSSLMODE production
npx vercel --prod
```

## API

Admin endpoints accept the token in either the `X-Admin-Token` header or the legacy `adminToken` JSON body field.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/generate-key` | Create a new key and return its loadstring |
| `POST /api/validate-key` | Validate or activate a key for a device |
| `GET /api/loader` | Return the Lua loader used by generated loadstrings |
| `POST /api/loader` | Validate a key/device and return raw attached script content |
| `POST /api/reset-hwid` | Reset a key binding, optionally for one device |
| `POST /api/blacklist-hwid` | Blacklist a device ID |
| `POST /api/unblacklist-hwid` | Remove a device ID from the blacklist |
| `POST /api/key-info` | Read one key and its activations |
| `POST /api/all-keys` | List all keys |
| `POST /api/toggle-key` | Enable or disable a key |
| `POST /api/delete-key` | Delete a key and its device bindings |

## Validation Request

Use a device identifier that your own app is allowed to collect. The backend stores only an HMAC hash of that identifier.

```json
{
  "key": "KEY-ABCD-EFGH-JKLM-NPQR",
  "deviceId": "your-device-id",
  "userId": "optional-user-id"
}
```

Successful responses return `status: "activated"` for a first use on a device and `status: "validated"` for later checks.

## Loader Flow

Generate a key in the dashboard with a script URL. The API response includes a loadstring like:

```lua
script_key="KEY-ABCD-EFGH-JKLM-NPQR"; loadstring(game:HttpGet("https://your-project.vercel.app/api/loader", true))()
```

The loadstring downloads the Lua loader from `GET /api/loader`. The loader posts the key and device ID back to `POST /api/loader`; only after validation succeeds does the server fetch the key's `script_url` and return the raw script content. Errors still return JSON messages so the loader can show a useful failure reason.

For large obfuscated scripts, the loader tries a file-backed execution path first (`writefile` + `loadfile`) when the executor supports it, then falls back to `loadstring`.

The dashboard shows execution IPs from active device bindings. `activation_ip` is the first IP that bound the key to that device, and `last_ip` is updated each time the key validates or the loader returns script content.

`POST /api/generate-key` accepts:

```json
{
  "expiresInDays": 30,
  "maxUses": 1,
  "scriptUrl": "https://your-domain.example/main.lua",
  "notes": "optional"
}
```

Use scripts and script URLs you control. Keep admin tokens in environment variables only, and do not put secrets in distributed clients.

## Security Notes

- Production refuses to start with the development `ADMIN_TOKEN` or `DEVICE_HASH_SECRET`.
- Generated keys use 25 random characters split across five groups.
- Protected script URLs must use HTTPS unless they are localhost or `ALLOW_INSECURE_SCRIPT_URLS=true`.
- Set `SCRIPT_URL_ALLOWLIST` to a comma-separated list of allowed script hostnames so new keys cannot point at arbitrary domains.
- Loader and script responses are marked `Cache-Control: no-store`.
- The server stores HMAC hashes of device IDs, not raw device IDs.
- A hostile client can still inspect any script that is delivered to it. Obfuscation, server-side checks, and fast revocation help, but no client-delivered Lua can be made impossible to copy.
