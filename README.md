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

### Shopping list and the cheapest supermarket

- **🛒 Add to shopping list** on a recipe uses the amount you picked with the − / + stepper. Untick what you already have at home, and only the rest goes on the list.
- The list adds up the same ingredient from several recipes (250 g + 500 g Mehl = 750 g), shows which recipes need it, and sorts it by supermarket section. Tick things off while you shop, add your own items, or copy the list as text.
- **Where is it cheapest?** Choose your country (Germany, Austria or Switzerland) and enter your postcode or town once, or use your current location on the computer running the app. The app lists the supermarkets within 15 km, from OpenStreetMap, free. Village shops of the big chains (Volg, Spar, Nah&Frisch, ADEG, Coop Pronto, Migrolino) are included. If OpenStreetMap is overloaded, two other map servers are tried; if all are down, the comparison still runs and Claude looks up the local chains itself.
- With Claude switched on, **Compare prices** has Claude search current prices and this week's offers of those chains online and estimate the total for your list at each. You get the cheapest one, a ranking with distances, the price per item (offers and estimates marked) and the sources. Prices are in the country's currency (CHF in Switzerland, EUR in Germany and Austria) and come from that country's shops and leaflet sites (e.g. migros.ch, coop.ch and denner.ch in Switzerland; billa.at, spar.at and hofer.at in Austria). It takes about a minute and costs roughly 20–50 cents. The result is an estimate; prices in a particular branch can differ.

### What Claude costs

Every Claude action (reading a recipe, translating, comparing prices) is measured from the tokens and web searches it used, at Anthropic's list prices, and saved in `data/usage.json`. The app shows the cost after a translation or price comparison, and **⋮ → Language & settings → Claude costs** shows this month and all time, per action. The price list is in `lib/usage.js`.

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
| `ANTHROPIC_API_KEY` | (none) | Optional. Lets Claude read recipes from photos and messy pasted text, translate recipes and compare supermarket prices |

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

## Publishing it for others (accounts and paid credit)

By default the app is a personal, single-user app with no login, and Claude is billed
to your own Anthropic key. To run it as a website for other people, start it in
**hosted mode**:

- People create an account (e-mail + password). Each account has its own recipes,
  photos, shopping list and settings.
- Recipes, shopping list and cooking mode are free. Everything that uses Claude
  (reading a recipe, translating, price comparison) is paid from **prepaid credit**.
- Each action is charged at its *measured* Claude cost × `PRICE_MARKUP` (default 3),
  converted to CHF (Switzerland) or EUR (Germany, Austria). Users see the typical
  price on the button before they click, and the exact amount afterwards.
- Credit is topped up in packs of 5, 10 or 20 through **Stripe Checkout** (cards,
  Apple Pay, Google Pay, TWINT, SEPA – whatever you switch on in Stripe).

### Settings

| Variable | What it does |
| --- | --- |
| `MULTI_USER=1` | Turns on hosted mode (accounts, credit, payments). |
| `ANTHROPIC_API_KEY` | Your Claude key – all users' actions run on it. |
| `PUBLIC_URL` | The public address, e.g. `https://rezepte.example.ch` (Stripe sends people back here). |
| `STRIPE_SECRET_KEY` | `sk_test_…` while testing, `sk_live_…` when live. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` of the webhook endpoint (see below). |
| `PRICE_MARKUP` | Price relative to the Claude cost. Default `3`. |
| `USD_TO_EUR`, `USD_TO_CHF` | Exchange rates for prices. Defaults `0.86` / `0.80` – set current rates. |
| `START_CREDIT` | Free credit for new accounts in cents/Rappen, e.g. `50`. Default `0`. |
| `TRUST_PROXY=1` | Set when running behind a reverse proxy (for correct client IPs in rate limiting). |
| `DATA_DIR` | Where accounts and user data are stored. Back this folder up. |

Stripe needs Node.js 20 or newer.

```bash
MULTI_USER=1 PUBLIC_URL=https://rezepte.example.ch \
ANTHROPIC_API_KEY=sk-ant-… STRIPE_SECRET_KEY=sk_live_… STRIPE_WEBHOOK_SECRET=whsec_… \
npm start
```

### Stripe setup

1. Create a Stripe account and complete the business details.
2. Under **Settings → Payment methods**, switch on what you want (TWINT for CHF, SEPA for EUR, …).
3. Under **Developers → Webhooks**, add the endpoint `https://<your address>/api/billing/webhook`
   with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Test with `sk_test_…` and the card `4242 4242 4242 4242` first.

Credit is booked when Stripe calls the webhook, and also when the user returns to the
account page; each payment is only ever booked once.

### Hosting

Run it on any server with Node.js (a small VPS, Render, Railway, Fly.io, …) behind HTTPS
– login cookies need HTTPS. The data folder must be on persistent storage.

### Before you go live

Selling credit makes this a business. Check with a professional for your country, at least:
an imprint (Impressum), terms (AGB) that explain how credit works and whether it expires,
a privacy policy (Datenschutzerklärung – the app stores e-mail addresses and sends recipe
text to Anthropic, OpenStreetMap and Stripe), and VAT on the credit you sell.

## Development

```sh
npm test
```

```
server.js          HTTP server: JSON API, file uploads, static files
lib/store.js       Recipe storage (JSON file plus attachment files, atomic writes)
lib/importer.js    Website/video link import (schema.org JSON-LD, microdata, Open Graph) and pasted-text parsing
lib/ai.js          Optional: Claude reads and translates recipes and compares supermarket prices (needs ANTHROPIC_API_KEY)
lib/shopping.js    Shopping list storage (data/shopping.json), adding up amounts across recipes
lib/places.js      Location lookup and nearby supermarkets from OpenStreetMap (Nominatim, Overpass)
lib/usage.js       What each Claude action cost (price list and usage log)
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
| GET/PUT | `/api/settings`                   | `{ "language": "de", "autoTranslate": true, "location": {…} }` |
| POST   | `/api/location`                    | `{ "query": "8001", "country": "CH" }` or `{ "lat", "lon" }`: look up and save the location |
| DELETE | `/api/location`                    | Forget the location                              |
| GET    | `/api/shopping`                    | The shopping list and the last price comparison  |
| POST   | `/api/shopping/items`              | `{ "lines": ["200 g Mehl"], "source": { "id", "title" } }` or `{ "text": "…" }` |
| PATCH  | `/api/shopping/items/:id`          | `{ "checked": true }`                            |
| DELETE | `/api/shopping/items/:id`          |                                                  |
| POST   | `/api/shopping/clear`              | `{ "checked": true }` removes ticked items; `{}` empties the list |
| GET    | `/api/shopping/stores`             | Supermarkets within 15 km of the saved location   |
| GET    | `/api/usage`                       | Claude costs this month and all time, per action |
| POST   | `/api/shopping/compare`            | Price comparison by Claude (needs an API key)    |
| POST   | `/api/recipes/:id/translate`       | `{ "to": "en" }`: translate; the original is kept in `original` |
| POST   | `/api/recipes/:id/original`        | Put the original text back                       |
| POST   | `/api/ai/extract`                  | `{ "text": "…" }` or `{ "images": [{ "type", "data" }] }` → draft recipe (not saved) |
| GET    | `/api/export`                      | Full backup with files embedded                  |
| POST   | `/api/import/backup`               | A backup file; adds its recipes as new copies    |

In hosted mode there are also (all non-GET requests need the header `X-Recipe-Box: 1`):

| Method | Path                               | What it does                                     |
| ------ | ---------------------------------- | ------------------------------------------------ |
| POST   | `/api/auth/register`               | `{ "email", "password", "country": "CH" }`       |
| POST   | `/api/auth/login`                  | `{ "email", "password" }`                        |
| POST   | `/api/auth/logout`                 |                                                  |
| POST   | `/api/auth/delete`                 | `{ "password" }`: delete the account and its data |
| GET    | `/api/billing`                     | Balance, history, top-up packs, prices per action |
| POST   | `/api/billing/checkout`            | `{ "amount": 1000 }` → Stripe Checkout URL       |
| POST   | `/api/billing/confirm`             | `{ "sessionId": "cs_…" }`: book a finished payment |
| POST   | `/api/billing/webhook`             | Stripe webhook (signed)                          |
