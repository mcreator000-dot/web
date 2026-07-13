# Key System

Node.js and Express license-key backend with a small admin dashboard.

It uses SQLite for local development. On Vercel, set `DATABASE_URL` and it will use Postgres instead.

This service validates licenses and binds them to device identifiers. It does not fetch or execute remote client code; after validation succeeds, your own app should unlock the licensed features it already contains.

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
DATABASE_URL=postgres://...
PGSSLMODE=require
```

5. Deploy the project.

The admin dashboard will be at your Vercel URL, and API routes stay the same, such as `/api/health`, `/api/generate-key`, and `/api/validate-key`.

### Vercel CLI

```bash
cd key-system
npm install
npx vercel
npx vercel env add ADMIN_TOKEN production
npx vercel env add DEVICE_HASH_SECRET production
npx vercel env add CORS_ORIGIN production
npx vercel env add DATABASE_URL production
npx vercel env add PGSSLMODE production
npx vercel --prod
```

## API

Admin endpoints accept the token in either the `X-Admin-Token` header or the legacy `adminToken` JSON body field.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/generate-key` | Create a new key |
| `POST /api/validate-key` | Validate or activate a key for a device |
| `POST /api/reset-hwid` | Reset a key binding, optionally for one device |
| `POST /api/blacklist-hwid` | Blacklist a device ID |
| `POST /api/unblacklist-hwid` | Remove a device ID from the blacklist |
| `POST /api/key-info` | Read one key and its activations |
| `POST /api/all-keys` | List all keys |
| `POST /api/toggle-key` | Enable or disable a key |

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

## Client Integration Example

```js
async function validateLicense(key, deviceId, userId) {
  const response = await fetch("https://your-project.vercel.app/api/validate-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, deviceId, userId }),
  });

  const data = await response.json();
  if (!response.ok || !data.success) {
    throw new Error(data.message || "License validation failed");
  }

  return data;
}
```

Use the returned success response as an authorization signal inside your own application. Keep privileged logic server-side when possible, and do not put secrets in distributed clients.
