# MayPharm API

NestJS service behind the MayPharm field app and admin portal. It is the only
component that holds the Supabase service-role key: it authenticates every
request, enforces roles, validates input, and brokers access to the private
file bucket.

## How uploads work

Files never pass through this API or the web server. That keeps large uploads
fast, avoids the 1 MB Server Action limit, and keeps memory flat.

```
browser ──1. POST /admin/uploads {name, size}──▶ API   validates type + size, returns a signed URL
browser ──2. PUT <file bytes> (with progress)──▶ Supabase Storage
browser ──3. POST /admin/content {…, uploadIntentId}──▶ API
                                                    reads the stored object's first bytes,
                                                    checks size and file signature,
                                                    claims the upload, saves the record
```

- **Verification:** every file is sniffed before a record may reference it (a
  renamed `.exe` is rejected and deleted). Types are decided by extension, never
  by the browser's reported MIME.
- **No orphans:** a failed save deletes the uploaded file; replacing or removing
  a file deletes the old one; deleting a record deletes its file.
- **Abandoned uploads** (tab closed after uploading) are swept automatically
  24 h later. The sweeper runs 1 minute after boot, then every 30 minutes.
- **Streaming** is piped, never buffered, and forwards `Range` with a true
  `206`, so video seeking works (Safari/iOS require it).

Accepted types: PDF, PNG, JPG, WEBP, MP4, MOV, WEBM, CSV, XLSX, DOCX, PPTX, up
to 50 MB (logos: PNG/JPG/WEBP, 2 MB). The limits live in
`src/storage/file-policy.ts`, mirrored for instant feedback in the web app's
`src/lib/uploads/rules.ts`.

## Access rules

| Caller | Can |
| --- | --- |
| No session / invalid token | nothing (`401`) |
| Signed in, no MayPharm profile, or profile not `active` | nothing (`403`); public sign-up on Supabase grants no access |
| Active member | read approved content, brands, categories; stream approved files |
| Admin (not suspended) | everything under `/admin/*` |

Suspending a user bans their Supabase login and blocks their existing tokens
immediately. Admins cannot remove their own admin access, and the last active
admin cannot be demoted.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Project API URL, e.g. `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Secret. Never expose to a browser. |
| `CORS_ORIGINS` | yes in prod | Comma-separated web origins, e.g. `https://app.maypharm.com` |
| `PORT` | no | Railway injects it. Defaults to `3000`. |
| `HOST` | no | Defaults to `0.0.0.0`. |
| `ASSET_BUCKET` | no | Defaults to `maypharm-admin-assets`. |
| `NODE_ENV` | no | `production` in the Docker image. |

Configuration is validated at boot; a missing or malformed variable fails the
deploy with a message naming it. Outside production a local `.env` is loaded
automatically (real environment variables always win).

## Local development

```bash
pnpm install
cp .env.example .env      # fill in real values
pnpm start:dev            # http://localhost:3000 (or PORT from .env)

pnpm test                 # unit tests
pnpm test:e2e             # HTTP contract tests (no Supabase needed)
pnpm lint
pnpm build
```

## Deploying on Railway

1. **Apply database migrations first** (see below).
2. Create a service from this repo. `railway.json` selects the Dockerfile and
   the `/health` healthcheck; nothing else needs configuring.
3. Set the environment variables above.
4. Deploy. `GET /health` is liveness; `GET /health/ready` also checks that
   Supabase Auth and Storage are reachable from the instance.

The image is a multi-stage build that installs production dependencies only and
runs as an unprivileged user.

## Database migrations

SQL migrations live in `supabase/migrations/` and must be applied in order.
They are idempotent. Apply a new one with the Supabase CLI
(`supabase db push`), or paste it into the Supabase SQL editor, or:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/<file>.sql
```

`202610210006_production_hardening.sql` is required by the upload flow
(`upload_intents` table, file metadata columns, expanded bucket types).

## Operations

- **Logs:** one line per request with method, path, status, duration and a
  request id (`x-request-id`, also returned in every error body). 5xx errors log
  a stack trace; the client only ever sees a generic message plus the id.
- **Rate limits:** per signed-in account (not per IP: all browser traffic
  arrives via the web server). 1200 req/min default, 60/min for upload slots,
  30/min for account creation.
- **Deleting users:** use suspension. Audit events reference the acting user,
  so Supabase refuses to delete an account that has any history.
- **Security headers** via Helmet; request bodies are capped at 256 KB (files
  never pass through here).
