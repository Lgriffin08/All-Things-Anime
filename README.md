# All Things Anime ✦

The latest anime news, announcements, trailers, delays, streaming updates and seasonal lineups, all in one place. When you open the app it greets you by name and shows live weather for Boca Raton / FAU.

## Features

- **News feed**: newest stories first, with headline, image, summary, source, date and a link to the full article. Refreshes automatically every 10 minutes, and again when you come back to the tab.
- **"NEW" badge** on stories from the last 24 hours.
- **Categories**: Announcements, Release dates, Trailers, Delays, Streaming and Industry.
- **Search**: look up news about any anime. It filters the current headlines and also pulls that show's dedicated news from MyAnimeList.
- **Seasonal lineup**: what's airing now and what's coming next, with scores, genres and broadcast times.
- **Watchlist**: follow your favorite shows and see news about only them. Saved in your browser.
- **Greeting**: a time-of-day greeting for Latrell (in English and Japanese).
- **Live weather** from Open-Meteo. Defaults to Boca Raton (FAU), and you can change the city.
- **Themes**: Light, Dark or System (follows your device).
- **Responsive**: works on phone, tablet and desktop.

## Data sources (all free, no API keys)

| Source | Used for |
| --- | --- |
| [Anime News Network RSS](https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us) | Main news feed |
| [Jikan API](https://jikan.moe/) (MyAnimeList) | Per-show news, search, seasonal lineups |
| [Open-Meteo](https://open-meteo.com/) | Live weather and city search |

## Deploy to Netlify

This is a static site with no build step.

1. In Netlify, choose **Add new site → Import an existing project** and pick this repo.
2. Leave the build command empty and set the publish directory to `.` (`netlify.toml` already does this).
3. Deploy.

`netlify.toml` proxies `/api/ann` to the Anime News Network RSS feed, so the browser can read it without CORS errors. You can also drag and drop the project folder into Netlify Drop.

## Run locally

```bash
npx serve .        # or: python3 -m http.server 8080
```

Locally, the `/api/ann` proxy isn't available, so the app automatically falls back to a public CORS proxy for the ANN feed. Use `npx netlify dev` to get the real proxy.

## Project structure

```
index.html        # markup and layout
css/styles.css    # theme tokens (light/dark), responsive layout
js/api.js         # ANN RSS, Jikan and Open-Meteo data layer (with caching and rate limiting)
js/app.js         # state, rendering, search, watchlist, themes, greeting, weather
netlify.toml      # Netlify config and ANN proxy
```
