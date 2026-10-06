# All Things Anime ✦

The latest anime news, announcements, trailers, delays, streaming updates and seasonal lineups, all in one place. When you open the app it greets you by name and shows live weather for Boca Raton / FAU.

## Features

- **News feed**: newest stories first, with headline, image, summary, source, date and a link to the full article. Refreshes automatically every 10 minutes, and again when you come back to the tab.
- **"NEW" badge** on stories from the last 24 hours.
- **Categories**: Announcements, Release dates, Trailers, Delays, Streaming and Industry.
- **Search**: look up news about any anime. AniList finds the show and all its titles (English, romaji, Japanese) so matching stories are found, with links to the ANN and MAL archives for older coverage.
- **Seasonal lineup**: what's airing now and what's coming next, with scores, genres and broadcast times.
- **Watchlist**: follow your favorite shows and see news about only them. Saved in your browser.
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
js/app.js         # state, rendering, search, watchlist, themes, greeting, weather
netlify.toml      # Netlify config
```
