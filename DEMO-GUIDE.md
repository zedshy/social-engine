# Social Engine — Classic view demo

> For the Content Studio (Studio, Assistant, Library, Analytics), use `STUDIO-DEMO-GUIDE.md`. This guide is the **Classic view** in the sidebar and works without an OpenAI key.

## Before you present

- `npm install` then `npm start`, or double-click `Start Social Engine.command` on a Mac.
- Open `http://127.0.0.1:8080/` in the same browser each time; drafts live in that browser.
- Open **Classic view**. For a clean run, click **Reset Demo** and confirm. That deletes this browser’s saved posts.
- Rehearse once. The controlled demo needs no API key. Live AI needs `OPENAI_API_KEY`, internet, and OpenAI credit.

## Suggested sequence

1. **Weekly Posts:** click **Create week**. Explain that source material, angle, audience and voice guide the separate AI action. Click **Load prepared demo week** (under Prepared demo options) to show the controlled London Tech Community example week.
2. Select different posts. Show editing, automatic save and the review notes. Prepared demo posts are demonstration content; they are not freshly generated from the source box.
3. **Optional live week:** with reviewed source material, choose **Weekly Batch** and **Generate Posts**. The local server makes three sequential OpenAI requests. Each draft still needs human review.
4. Show **saved content**. Create week opens the form without deleting previous batches.
5. **Optional live single post:** **Single Post** then **Generate Posts**. White-paper and trade-fair angles are AI-only; supply the excerpt or event context. Do not invent event details.
6. **Community visual:** the picture icon opens the guided example. Generate Visual shows the first SVG concept. Refine Visual then Apply Feedback shows the improved concept. Explain that organiser review still matters.
7. **Baseline, Analytics and Plan:** measurement boundaries, sample analytics (not live community performance), and an indicative 30/60/90 approach — not an approved budget.

## What to say clearly

- **Simulated:** Load prepared demo week, demo variations, and the guided visual sequence.
- **Live OpenAI:** Generate Posts and Generate AI variation. Without a key, the app explains the setup and the controlled demo remains usable.
- **Not publishing:** approval and Published statuses are manual records. The app does not post to LinkedIn.
- **Storage:** drafts stay in this browser only.

## Finish

Stop the server with `Stop Social Engine.command` or Ctrl-C in the terminal, then close the tab.
