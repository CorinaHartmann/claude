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

- **search** across titles, ingredients, steps, notes, tags and file names (press `/` to jump to search)
- **filter** by tag or favorites, and **rate** recipes from 1 to 5 stars
- **scale** ingredients to ½×, 2× or 3×
- **tick off** ingredients and steps while you cook
- **print** a clean copy of a recipe
- **attach** more photos or files to any recipe and pick one as the cover
- **back up** everything (recipes *and* files) to one file, and restore it

Shortcuts: drag files or links anywhere onto the page, or paste (Ctrl/⌘+V) an image, a link or recipe text.

## Running it

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else gets installed.

```sh
npm start
```

Then open <http://localhost:3000>.

Your recipes are saved in `data/`: `recipes.json` plus a `files/` folder. Copy that folder to move or back up everything. You can also use **⋮ → Download backup** in the app.

| Setting    | Default   | Meaning                                    |
| ---------- | --------- | ------------------------------------------ |
| `PORT`     | `3000`    | Port to listen on                          |
| `HOST`     | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to keep it to this computer only |
| `DATA_DIR` | `./data`  | Where recipes and files are stored         |

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
public/            The web app (plain HTML/CSS/JS, installable as a PWA, works offline for recipes you've opened)
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
| GET    | `/api/export`                      | Full backup with files embedded                  |
| POST   | `/api/import/backup`               | A backup file; adds its recipes as new copies    |
