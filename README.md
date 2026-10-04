# Recipe Box

One central place for all your recipes, however you found them.

| Save from…                         | What happens                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| 🔗 **Any recipe website**          | Title, photo, ingredients, steps, times and servings are pulled in for you.  |
| 🎬 **YouTube, TikTok, Instagram, Vimeo** | The video plays right inside the recipe. A recipe in the caption is picked up when the page includes it. |
| 📷 **Photos and scans**            | Cookbook pages, handwritten cards, screenshots. Take a photo straight from your phone. |
| 📄 **PDFs and documents**          | PDFs open inline. Word docs, spreadsheets and anything else can be downloaded again. |
| 🎙️ **Video and audio files**       | They play inline, so a voice memo from Grandma works too.                    |
| 📋 **Pasted text**                 | Emails, messages, notes: the text is split into title, ingredients and steps. |
| ✍️ **Typed by hand**               | Start from a blank recipe.                                                   |

Then you can:

- **cook step by step**: ▶ Start cooking shows one step per screen in large text, with Next/Back or swipe, and keeps the screen on
- **use timers**: times in steps ("15 minutes", "20–25 Min.", "1 Std. 30 Min.") become timer buttons; several can run at once, and they ring when done
- **choose how much to make**: a − / + stepper shows the real amount ("12 slices", "4 people") and every ingredient adjusts, rounded the way you'd measure
- **search** across titles, ingredients, steps, notes, tags and file names (press `/` to jump to search)
- **filter** by tag or favorites, and **rate** recipes from 1 to 5 stars
- **tick off** ingredients and steps while you cook
- **print** a clean copy of a recipe
- **attach** more photos or files to any recipe and pick one as the cover
- **back up** everything (recipes *and* files) to one file, and restore it

### Languages

The app speaks German, English, French, Italian, Spanish and Dutch. Choose the language under **⋮ → Language & settings**; the first time, the app picks your browser's language.

With Claude switched on (see below), recipes can be translated into that language too:

- **Translate all**: one button on the settings page translates every recipe that's in another language, with a progress bar.
- **Translate new recipes automatically**: on by default; a recipe is translated when you save it.
- **Translate one**: a recipe in another language shows a "Translate into …" button.
- **Nothing is lost**: the original text is kept. On a translated recipe, **Show original** switches between the two, and **Restore original** goes back for good.

Amounts and numbers are never changed; units are written the usual way for the language (EL ↔ tbsp, TL ↔ tsp). The language of a recipe is recognised without Claude, so recipes already in your language are skipped and cost nothing.

Every recipe is formatted the same way however it was added: amounts first ("200 g Mehl"), consistent units and fractions ("1½ tbsp"), steps as numbered sentences, times as "1 h 30 min", servings as "4 people" or "20 slices".

Shortcuts: drag files or links anywhere onto the page, or paste (Ctrl/⌘+V) an image, a link or recipe text.

## Running it

You need [Node.js](https://nodejs.org) 18 or newer.

```sh
npm install
npm start
```

Then open <http://localhost:3000>.

Your recipes are saved in `data/`: `recipes.json` plus a `files/` folder. Copy that folder to move or back up everything. You can also use **⋮ → Download backup** in the app.

| Setting    | Default   | Meaning                                    |
| ---------- | --------- | ------------------------------------------ |
| `PORT`     | `3000`    | Port to listen on                          |
| `HOST`     | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to keep it to this computer only |
| `DATA_DIR` | `./data`  | Where recipes and files are stored         |
| `ANTHROPIC_API_KEY` | (none) | Optional. Lets Claude read recipes from photos and messy pasted text, and translate recipes |

### Letting Claude read recipes (optional)

Without a key, pasted text is split into ingredients and steps by simple rules. With an [Anthropic API key](https://console.anthropic.com/), Claude reads pasted page text, captions and photos of recipe cards or cookbook pages instead, which is much more reliable. Each read is a paid API call on your Anthropic account.

```sh
# macOS / Linux
ANTHROPIC_API_KEY=sk-ant-... npm start
# Windows (PowerShell)
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start
```

When it's on, the editor shows **✨ Fill in with Claude** and **✨ Read from photos**, and recipes can be translated (see Languages above).

### Using it on your phone

1. Run the server on a computer that stays on (a desktop, a Raspberry Pi or a small home server).
2. On your phone, on the same Wi-Fi, open `http://<that-computer's-IP>:3000`.
3. Add it to your home screen: **Share → Add to Home Screen** on iPhone, or **⋮ → Install app** on Android.

On Android, the installed app shows up in the **Share** menu, so you can share a recipe link or video from Chrome, YouTube or TikTok straight into Recipe Box.

> **Privacy note:** there are no accounts or passwords, and anyone who can reach the server can see and edit your recipes. Keep it on your home network. To reach it from outside your home, put it behind something that adds a login, such as Tailscale or a reverse proxy with authentication.

## Development

```sh
npm test
```

```
server.js          HTTP server: JSON API, file uploads, static files
lib/store.js       Recipe storage (JSON file plus attachment files, atomic writes)
lib/importer.js    Website/video link import (schema.org JSON-LD, microdata, Open Graph) and pasted-text parsing
lib/ai.js          Optional: Claude reads recipes from text or photos (needs ANTHROPIC_API_KEY)
public/recipe-kit.js  Shared by server and browser: formatting, servings and amounts, timer durations, language detection
public/i18n.js     App texts in German, English, French, Italian, Spanish and Dutch
public/            The web app (plain HTML/CSS/JS, installable as a PWA, works offline for recipes you've opened)
online/            The claude.ai version of the app (one HTML file; runs only on claude.ai)
test/              Tests (node:test)
```

### API

| Method | Path                               | Body / notes                                     |
| ------ | ---------------------------------- | ------------------------------------------------ |
| GET    | `/api/recipes?q=&tag=&favorite=1`  | List and search                                  |
| POST   | `/api/recipes`                     | JSON recipe                                      |
| GET    | `/api/recipes/:id`                 |                                                  |
| PUT    | `/api/recipes/:id`                 | Partial JSON update                              |
| DELETE | `/api/recipes/:id`                 | Also deletes its files                           |
| POST   | `/api/recipes/:id/files`           | Raw file body, `Content-Type`, `X-Filename` (URI-encoded), up to 200 MB |
| DELETE | `/api/recipes/:id/files/:fileId`   |                                                  |
| GET    | `/files/:fileId`                   | Download or view an attachment                   |
| GET    | `/api/tags`                        | Tags with counts                                 |
| POST   | `/api/import/url`                  | `{ "url": "…" }` → draft recipe (not saved)      |
| POST   | `/api/import/text`                 | `{ "text": "…" }` → draft recipe (not saved)     |
| GET    | `/api/config`                      | `{ "ai": true/false }`: whether Claude reading is on |
| GET/PUT | `/api/settings`                   | `{ "language": "de", "autoTranslate": true }`    |
| POST   | `/api/recipes/:id/translate`       | `{ "to": "en" }`: translate; the original is kept in `original` |
| POST   | `/api/recipes/:id/original`        | Put the original text back                       |
| POST   | `/api/ai/extract`                  | `{ "text": "…" }` or `{ "images": [{ "type", "data" }] }` → draft recipe (not saved) |
| GET    | `/api/export`                      | Full backup with files embedded                  |
| POST   | `/api/import/backup`               | A backup file; adds its recipes as new copies    |
