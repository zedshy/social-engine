# Handoff notes — Social Engine

Read this before changing behaviour. Most of it exists to stop someone losing a day to a problem that has a one-line explanation.

## 1. Demo vs live

The **Classic view** (`index.html`) can draft a prepared week with no API key. **Generate Posts** goes through `server.js` and the official OpenAI SDK and needs `OPENAI_API_KEY` in `.env`.

`npm start` serves `http://127.0.0.1:8080`. `npm test` runs mocked checks without a key.

If you open the HTML from disk, the page still renders and **Load prepared demo week** works. Only the local Node server enables live OpenAI.

## 2. What this is

One Node server, two front ends (`app.html` Studio and `index.html` Classic), brand profiles in `profiles/`, and no autoposting. Drafts live in `localStorage`.

## 3. Brand profiles

The default profile is a London developer/hackathon community (`profiles/default.json`). Load another with `POST /api/profiles/load`. Extract from a website with `POST /api/profile/extract`. Saved profiles go to `BRAND_PROFILE` (default `profiles/default.json`).

## 4. Things that will look wrong but aren’t

- Chart colours are chosen for colourblind separation, not by eye.
- Theme tokens are declared for light, dark and `prefers-color-scheme`. A colour defined in only one of them produces unreadable UI.
- Analytics sample data is fake and labelled as sample data.

## 5. Do not do before a demo

- Porting the runtime to another stack.
- Autoposting to LinkedIn.
- Real LinkedIn analytics APIs (there is no access; the Analytics tab is ingest-only).

## 6. Known gaps

- CSV parser is simple. A real LinkedIn export may need quoted-CSV parsing.
- Charts have hover tooltips but no keyboard interaction; the table is the accessible path.
- No server-side persistence. Pasted data is lost on reload except what `localStorage` keeps.

## 7. Status

Hackathon build. Drafted posts are suggestions requiring human approval before publication.
