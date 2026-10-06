# All Things Anime ✦

The latest anime news, announcements, trailers, delays, streaming updates and seasonal lineups, all in one place. When you open the app it greets you by name and shows live weather for Boca Raton / FAU.

## Features

- **News feed**: newest stories first, with headline, image, summary, source, date and a link to the full article. Refreshes automatically every 10 minutes, and again when you come back to the tab.
- **"NEW" badge** on stories from the last 24 hours.
- **Categories**: Announcements, Release dates, Trailers, Delays, Streaming and Industry.
- **Search**: look up news about any anime. AniList finds the show and all its titles (English, romaji, Japanese) so matching stories are found, with links to the ANN and MAL archives for older coverage.
- **Seasonal lineup**: what's airing now and what's coming next, with scores, genres and broadcast times.
- **Watchlist**: follow your favorite shows and see news about only them. Saved in your browser.
- **Accounts (email login)**: sign up, sign in, forgot/reset password and change password, powered by Supabase Auth. Signed-in users' watchlists are saved to their account and follow them to any device. Shows followed before signing in are merged into the account.
- **Profiles**: every account gets a profile page (`#profile`) with a photo (cropped and resized in the browser before upload), display name, unique @username, bio, favorite anime and up to 10 favorite genres. The display name is used in the greeting and the account button shows the photo.
- **Greeting**: a time-of-day greeting for Latrell (in English and Japanese).
- **Live weather** from Open-Meteo. Defaults to Boca Raton (FAU), and you can change the city.
- **Themes**: Light, Dark or System (follows your device).
- **Responsive**: works on phone, tablet and desktop.

## Data sources (all free, no API keys)

| Source | Used for |
| --- | --- |
| [Anime News Network RSS](https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us) | News feed |
| [MyAnimeList News RSS](https://myanimelist.net/rss/news.xml) | News feed (with images) |
| [AniList GraphQL API](https://anilist.co/graphiql) | Search, seasonal lineups, show artwork |
| [Open-Meteo](https://open-meteo.com/) | Live weather and city search |
| [Supabase](https://supabase.com/) (project `All Things Anime`) | Email login and saved watchlists |

## Supabase setup

- **Database**: a `public.watchlist` table (`user_id`, `anime_id`, `title`, `image`, `titles`, `created_at`) with row-level security, so each user can only read and change their own rows.
- **Profiles**: a `public.profiles` table (one row per user, created automatically by a trigger on sign-up and seeded with the first name). Usernames are unique (case-insensitive) and every field has length checks in the database. RLS lets users read and edit only their own profile.
- **Avatars**: a public `avatars` storage bucket (2 MB limit, JPG/PNG/WebP). Each user can only write inside their own folder (`avatars/{user_id}/`).
- **Keys**: `js/auth.js` contains the project URL and the *publishable* key. It's designed to be public; RLS protects the data. Never put the `service_role`/secret key in the site.
- **Required dashboard setting**: Authentication → URL Configuration → set **Site URL** to the Netlify URL and add `https://<your-site>.netlify.app/**` under **Redirect URLs**, so confirmation and password-reset emails link back to the site.
- **Email limits**: Supabase's built-in email sender only sends a few emails per hour (sign-up confirmations and password resets). Signing in with a password sends no email. For more volume, add custom SMTP under Authentication → Emails, or turn off "Confirm email" under Authentication → Sign In / Providers → Email.

## Deploy to Netlify

This is a static site with no build step.

1. In Netlify, choose **Add new site → Import an existing project** and pick this repo.
2. Leave the build command empty and set the publish directory to `.` (`netlify.toml` already does this).
3. Deploy.

The RSS feeds don't allow direct browser access (CORS), so a small Netlify Function (`netlify/functions/feed.mjs`, served at `/api/feed`) fetches them server-side and caches them for 5 minutes. Netlify deploys it automatically from the repo. Netlify Drop (drag and drop) does **not** deploy functions, so connect the Git repo instead.

## Run locally

```bash
npx serve .        # or: python3 -m http.server 8080
```

With a plain static server, `/api/feed` isn't available, so the app falls back to public CORS proxies for the news feeds. Use `npx netlify dev` to run the real function locally.

## Project structure

```
index.html        # markup and layout
css/styles.css    # theme tokens (light/dark), responsive layout
js/api.js         # RSS news, AniList and Open-Meteo data layer (with caching)
netlify/functions/feed.mjs  # server-side RSS relay at /api/feed
js/app.js         # state, rendering, search, watchlist, account UI, themes, greeting, weather
js/auth.js        # Supabase email login, watchlist sync, profiles and avatar uploads
netlify.toml      # Netlify config
```
