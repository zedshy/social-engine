# Deploying Social Engine

The app is a Node server. `api/index.js` and `vercel.json` let Vercel run it as a function. Render or any Node host can run `npm start`.

## Vercel

1. Import `zedshy/social-engine`.
2. Framework Preset: **Other**. Leave build and output empty.
3. Environment variables:

   | Name | Value |
   |---|---|
   | `OPENAI_API_KEY` | your OpenAI key |
   | `APP_PASSWORD` | a password you will share with testers |
   | `OPENAI_IMAGE_MODEL` | optional, defaults to `gpt-image-2` |
   | `OPENAI_RESEARCH_MODEL`, `OPENAI_WRITER_MODEL` | optional, default `gpt-4.1` |

4. Deploy, open the URL, enter the password (any username, then the password).

**Why `APP_PASSWORD` matters.** Every button spends OpenAI credit. Without a password a hosted copy refuses to run so a public link cannot be used by strangers.

## If something goes wrong

- **`maxDuration` is too large:** lower `300` in `vercel.json` to your plan’s limit.
- **504 on images:** use Render instead.
- **Buttons say “locked”:** add `APP_PASSWORD` and redeploy.
- **Everything 404s:** `vercel.json` must be in the repository root.

## Render or any Node host

Start command `npm start`, build command `npm ci --omit=dev`, Node 22 or later. Set `HOST=0.0.0.0` plus the same environment variables. Render sets `PORT` itself.

## Local

```bash
cp .env.example .env     # put the key in .env, never in .env.example
npm install
npm start                # http://127.0.0.1:8080
```

No password is needed locally. Demo mode works with an empty key.

## Checks before sharing a link

- `.env` is git-ignored and was never committed.
- `APP_PASSWORD` is set on the host.
- Rotate the OpenAI key or set a spending limit if a link is shared widely.
