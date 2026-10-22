# Social Engine: user manual

For the people who will use it. No technical knowledge needed. The same guide is inside the app under **Guide**.

## What it does

The Content Studio helps you turn industry news, community notes or an idea into LinkedIn posts with matching images. It never publishes anything itself. You always read the post and press **Post** yourself.

| Part | Use it for |
|---|---|
| **Dashboard** | See where you are this week and what to do next. |
| **Studio** | Plan a week of three posts from researched topics. |
| **Assistant** | Ask for any other post in your own words. |

## Quick start

1. Open the app and look at the **Dashboard**.
2. Go to **Studio** and press **Find latest topics**. This takes about 15 seconds.
3. Choose three ideas. Press **Auto-fill week**, or assign Mon / Wed / Fri.
4. Press **Write my week**. It writes three posts and checks each one against its sources.
5. For each post, press **Create image**, read the text, then **Post to LinkedIn**.

## From a link, screenshot or document

In **Studio**, press **From a link or screenshot**. Paste a URL or a screenshot, optionally say the angle (for example “what it means for first-time attendees”), pick a day, and press **Read it and build the post**. Only facts that are really in the page or screenshot are used.

**Add your own** uploads a PDF or Word file. Scanned PDFs without text cannot be read.

## Library photos

Open **Library** and add photographs (JPEG, PNG, WebP or HEIC). Tick **Cleared for public use** only when you have permission. On a post, press **Use a library photo**. Photos stay in your browser.

## Analytics

LinkedIn does not let tools read page analytics without special access. Mark a post as posted, or **Track a post**, then paste a LinkedIn link or upload a screenshot of the numbers.

## Assistant examples

- “Wish our members a happy Halloween.”
- “Thank everyone for a busy year. Keep it warm but short.”
- “We’ve opened a new meetup in Shoreditch on 3 November. Announce it.”

It will not invent dates, venues or numbers. For news, use Studio → Find latest topics.

## How accuracy works

Nothing is written from memory. After writing, a second check reads the post against the facts.

| You see | It means |
|---|---|
| **Source confirmed** | The link opened and the figures were on the page. |
| **Check the source** | The link was blocked or the figures were not found. |
| **Handle with care** | Sensitive news. Written neutrally. |
| Green fact-checked | Every sentence is supported. |
| Amber should-check | A sentence goes beyond the sources. Edit it first. |

## Troubleshooting

| Problem | What to do |
|---|---|
| “No OpenAI key” | Add `OPENAI_API_KEY` to `.env` and restart. Classic view still works. |
| Page can’t be reached | Start the app again (`npm start`). |
| Very few topics | Press Find latest topics again, or Add your own. |
| Image paste does nothing in LinkedIn | Use LinkedIn’s photo icon and the downloaded file. |
