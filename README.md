# MemeDex

A self-hosted library for reaction memes, built so you can find the right image to reply with, fast.

You know the meme you want: the dog raising its eyebrows, the slow clap, the "this is fine" dog. But when a message comes in, you can't find it in a folder of 800 images called `IMG_4821.png`. MemeDex fixes that. Every image gets **many** descriptions, written as the things you'd *mean* by sending it ("really?", "what did you just say", "excuse me?"). Then you search by meaning instead of by file name.

## Features

- **Upload** JPG, PNG, WebP and GIF images: drag and drop, paste with Ctrl+V, or pick files. The same image is never stored twice.
- **Many descriptions per image**, one per line, plus tags. A meme can be found by any one of its descriptions, so "wait, you did WHAT?" finds the eyebrow dog through "what did you just say", even though the two share no words.
- **✨ AI describe:** Claude looks at an image (or a whole selection, or every new upload) and writes 8–15 description lines, tags, a title and any text on the image. Your own lines and tags are never removed.
- **Find a reaction:** type what you want to say ("eye roll", "slow clap", "really?"). It's instant and free, with no AI call involved.
- **Reply to a message:** paste the message you got, or a screenshot of it. Claude works out what a good reply would say, searches your library, and picks the best few with a reason for each.
- **Copy image** puts the meme on your clipboard, ready to paste into any chat.
- **Private libraries:** each person who signs in gets their own library and uses their own Claude API key, chosen in Settings.

## How it works

| Part | What it is |
|---|---|
| Client | Angular 22 + Tailwind CSS (`client/`) |
| Server | NestJS + SQLite (`server/`). It also serves the web app, so everything runs in one container. |
| Sign-in | OIDC with PKCE in the browser. Register MemeDex as a **public** client; no client secret is used. |
| AI | Claude, through each user's own API key. Keys are stored encrypted with `SETTINGS_ENCRYPTION_KEY` and never sent back to the browser. You can pick Opus 5.5, Sonnet 5.5 or Haiku 5.5. |
| Search | A small embedding model (`all-MiniLM-L6-v2`) runs inside the container, with no external API, plus SQLite full-text search. |

**Why search works well:** every description line gets its own embedding, and an image's score is its *best* matching line. Averaging all of an image's lines would blur them together; this way one meme can be found by many different phrasings. Keyword matches (title, tags, descriptions, text on the image) and meaning matches are combined with reciprocal rank fusion.

**Reply to a message** takes three steps:
1. Claude reads the message and writes 6–10 things a reply could express.
2. Those phrases are searched.
3. Claude looks at the top 16 results (thumbnails and descriptions) and picks the best ones.

## Deploy

```sh
cp .env.example .env   # fill in OIDC_ISSUER, OIDC_CLIENT_ID, SETTINGS_ENCRYPTION_KEY
docker compose up -d --build
```

| Variable | Description |
|---|---|
| `OIDC_ISSUER` | Your OIDC provider, e.g. `https://oidc.example.com` (no trailing slash) |
| `OIDC_CLIENT_ID` | The public client registered for MemeDex |
| `SETTINGS_ENCRYPTION_KEY` | At least 32 characters (`openssl rand -base64 32`). Encrypts users' Claude API keys. |

### OIDC setup

Create a client for MemeDex in your OIDC provider (e.g. Pocket ID) with:

- [ ] **Public client: on.** MemeDex signs in from the browser and never sends a client secret. With a confidential client, sign-in fails at the token step. Ignore any secret the provider shows.
- [ ] **PKCE: on** (recommended). MemeDex always uses PKCE; turning this on makes the provider insist on it.
- [ ] **Redirect (callback) URI:** `https://<host>/callback`
- [ ] **Post-logout redirect URI:** `https://<host>`
- [ ] Copy the client ID into `OIDC_CLIENT_ID`, and the provider's base URL into `OIDC_ISSUER`.

For local development, also add `http://localhost:4200/callback` and `http://localhost:4200`, or use a separate dev client.

The compose file joins the external `dokploy-network`. The container listens on port 8080.

All data (database, images, thumbnails) lives in the `memedex_data` volume (`/app/data`), so back that up. If `SETTINGS_ENCRYPTION_KEY` is ever changed or lost, saved Claude keys can't be decrypted, and Settings asks each user to enter theirs again. Nothing else is affected.

Anyone your OIDC provider allows to sign in gets a library. To limit who can use MemeDex, restrict the client to certain users or groups in your provider.

## Local development

Requires Node ≥ 22.22.3 (Angular 22).

```sh
cd server && npm install && npm run fetch-model && npm run start:dev   # API on :8080, reads ../.env
cd client && npm install && npm start                                  # http://localhost:4200, proxies /api and /env.js
```

For local sign-in, also register `http://localhost:4200/callback` with the OIDC client, or use a separate dev client.

## Disclaimer

This project was made entirely by AI, just for fun. I wanted a way to search my reaction memes by what they *mean* and get suggestions for what to reply with. I couldn't find anything on the internet that did this, so I'm making it.

It's provided as-is, with no warranty. AI features use your own Claude API key and are billed to your Anthropic account.
