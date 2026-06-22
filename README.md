# Leafy Dew AI-CGO Backend

This is the first backend foundation for Leafy Dew AI-CGO.

It is a Node.js + TypeScript + Express backend for connecting Amazon seller accounts through Amazon SP-API OAuth.

This project does **not** include:

- Frontend
- AI engines
- PPC features
- Dashboard
- Image generation

## What Is Included

- `GET /health`
- `GET /api/amazon/connect-url`
- `GET /api/amazon/callback`
- `GET /api/amazon/status`
- `POST /api/amazon/test-connection`
- `GET /api/amazon/marketplaces`
- `POST /api/amazon/disconnect`
- Supabase database schema
- Token encryption with Node `crypto`
- Environment validation with `zod`
- Safe logging that redacts secrets

## Project Structure

```text
src/
  config/
    env.ts
  db/
    supabase.ts
  modules/
    amazon/
      amazon.routes.ts
      amazon.controller.ts
      amazon-auth.service.ts
      amazon-token.service.ts
      amazon-client.service.ts
      amazon.types.ts
    audit/
      audit.service.ts
  utils/
    encryption.ts
    logger.ts
    retry.ts
  server.ts
```

## Prerequisites

Install these first:

- Node.js 20 or newer
- npm
- A Supabase project
- An Amazon Seller Central developer app for SP-API

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
```

3. Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copy the output into `.env`:

```env
ENCRYPTION_KEY=the-generated-value
```

4. Fill in Supabase values in `.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

Important: the Supabase service role key must stay on the backend only. Never put it in frontend code.

5. Fill in Amazon values in `.env`:

```env
AMAZON_LWA_CLIENT_ID=your-amazon-lwa-client-id
AMAZON_LWA_CLIENT_SECRET=your-amazon-lwa-client-secret
AMAZON_APP_ID=your-amazon-sp-api-application-id
```

These values come from your Amazon Seller Central Developer Console.

6. Create database tables:

- Open Supabase
- Go to SQL Editor
- Paste the contents of `supabase.sql`
- Run the SQL

7. Start the backend:

```bash
npm run dev
```

The server should start at:

```text
http://localhost:4000
```

## Test The Server

Health check:

```bash
curl http://localhost:4000/health
```

Expected response:

```json
{
  "ok": true,
  "service": "Leafy Dew AI-CGO backend",
  "timestamp": "..."
}
```

## Amazon Connection Flow

Because there is no user system yet, the API uses a simple `sellerId` value that you provide.

In development, you can use something like:

```text
demo-seller-1
```

### 1. Get Amazon Connect URL

```bash
curl "http://localhost:4000/api/amazon/connect-url?sellerId=demo-seller-1&region=NA"
```

Response:

```json
{
  "connectUrl": "https://sellercentral.amazon.com/apps/authorize/consent?..."
}
```

Open the `connectUrl` in your browser. Amazon will ask the seller to approve your app.

### 2. Amazon Callback

After approval, Amazon redirects back to:

```text
http://localhost:4000/api/amazon/callback
```

The backend will:

- Validate the signed OAuth state
- Exchange the Amazon authorization code for tokens
- Encrypt tokens before saving
- Store the connection in Supabase

### 3. Check Status

```bash
curl "http://localhost:4000/api/amazon/status?sellerId=demo-seller-1"
```

### 4. Test Connection

```bash
curl -X POST http://localhost:4000/api/amazon/test-connection \
  -H "Content-Type: application/json" \
  -d "{\"sellerId\":\"demo-seller-1\"}"
```

### 5. Get Marketplaces

```bash
curl "http://localhost:4000/api/amazon/marketplaces?sellerId=demo-seller-1"
```

### 6. Disconnect

```bash
curl -X POST http://localhost:4000/api/amazon/disconnect \
  -H "Content-Type: application/json" \
  -d "{\"sellerId\":\"demo-seller-1\"}"
```

Disconnecting deletes stored Amazon tokens and marks the connection as disconnected.

## Important Amazon SP-API Note

This foundation handles the OAuth connection and encrypted token storage.

Live Amazon SP-API requests usually also require AWS Signature Version 4 request signing with IAM credentials. That production signing step is marked with TODO comments in the Amazon client service because this first foundation is intentionally limited to the stack requested here.

## Security Rules In This Project

- Amazon tokens are encrypted before saving.
- Amazon refresh tokens are never stored in plain text.
- Logs redact token and secret fields.
- Secrets are read from `.env`.
- `.env` should never be committed to git.
- Supabase Row Level Security is enabled in `supabase.sql`.
- No public RLS policies are added.
- The Supabase service role key is used only by the backend.

## Useful Commands

Run in development:

```bash
npm run dev
```

Check TypeScript:

```bash
npm run typecheck
```

Build:

```bash
npm run build
```

Run compiled JavaScript:

```bash
npm start
```
