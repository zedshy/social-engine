# Social Engine

**Paste a website URL, get a brand profile, then research, write, fact-check and lint a week of sourced social posts — without inventing facts.**

## What it does

Social Engine is a white-label AI content desk for small brands and communities. It turns a public website and a handful of source facts into a reviewable post library:

1. **Brand setup from a URL** — extract name, tagline and voice into a brand profile, or load the included London Tech Community demo.
2. **Research** — live web search and RSS, with trusted-source rules and link checks.
3. **Write** — drafts for Monday / Wednesday / Friday slots in the profile voice.
4. **Fact-check and lint** — every sentence must rest on supplied facts; hype, emoji and unsourced claims are flagged.
5. **Post library** — edit, revise, brief images, and copy to LinkedIn. Nothing publishes until a human presses Post.

The default demo profile is a **London developer / hackathon community**, not a vendor brand.

## Why this is a 10x improvement over generic AI copywriting

Generic chat tools write confident marketing copy from memory. Small brands and volunteer communities cannot afford invented statistics, fake events or a voice that sounds like every other LinkedIn bot.

Social Engine is built the other way around:

- **Sources first.** Research has to return real URLs and dated facts. Posts may only restate those facts.
- **A second checker.** A separate pass flags anything the draft added.
- **Brand-shaped, not prompt-shaped.** Voice, banned wording, hashtags, research topics and image scenes live in a profile JSON — swap the profile, swap the brand.
- **Demo without a key.** Judges can click through the Classic week and the Studio UI with no OpenAI account. Live generation is opt-in.
- **Human approval is the product.** Statuses, LinkedIn hand-off and analytics ingest are manual on purpose.

That is the difference between “write me some posts” and an editor’s desk that a community can actually trust.

## Quick start

```bash
npm install
npm start
# Open http://127.0.0.1:8080
```

**Demo mode (no API key):** the Studio UI, Classic view, prepared demo week, and library all work. Live research, writing and images need a key.

**Live mode:** copy `.env.example` to `.env` and set `OPENAI_API_KEY`.

```bash
npm test
```

Tests use mock OpenAI clients. No paid calls.

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | none | Required for live AI. Leave empty for demo mode. |
| `OPENAI_RESEARCH_MODEL` | `gpt-4.1` | Web search and research |
| `OPENAI_WRITER_MODEL` | `gpt-4.1` | Post writing |
| `OPENAI_IMAGE_MODEL` | `gpt-image-2` | Image generation |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Fact-checking, Assistant, Classic view |
| `PORT` | `8080` | Server port |
| `BRAND_PROFILE` | `profiles/default.json` | Active brand profile path |
| `APP_PASSWORD` | none | Required for hosted deployments so a public URL cannot spend the key |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` on most hosts) |

## Deploy to Vercel

1. Import this repo. Framework preset: **Other**. Leave build and output empty.
2. Set `OPENAI_API_KEY` and `APP_PASSWORD` in project environment variables.
3. Deploy. The browser asks for the password (any username, then the password).

`api/index.js` and `vercel.json` run the same Node handler as `npm start`. Image generation can hit plan time limits; lower `maxDuration` in `vercel.json` if the build rejects `300`, or use Render with `npm start`.

## Project structure

```
app.html              Content Studio (dashboard, research, write, library, analytics)
index.html            Classic weekly-posts view (works without a key)
server.js             HTTP server, profile APIs, Classic generate route
studio.js             Studio routes: research, write, images, extract
studio-content.js     Prompts, fact-check, lint
studio-extract.js     URL / screenshot / document extraction
brand-profile.js      Profile load/save and website extract
news-discovery.js     RSS discovery (metadata only)
post-library.js       Local draft library model
profiles/             Example brand profiles (London Tech Community is default)
assets/brand/         Neutral SVG logo
```

## Credits

Built by **Zeshaan Qureshi** ([@zedshy](https://github.com/zedshy)) and **Dani** ([@MDG-2001](https://github.com/MDG-2001)) with **Grok Bot** and **Cursor**, for the Grok Bot Community Engineering London Hackathon.

## License

MIT © 2026 Zeshaan Qureshi. See `LICENSE`. Lucide icons: `assets/lucide-LICENSE.txt`.
