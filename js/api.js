// Data layer: Anime News Network + MyAnimeList RSS news, AniList anime data, Open-Meteo weather.
// All sources are free and need no API key.

const ANILIST = 'https://graphql.anilist.co';
const FEEDS = {
  ann: { url: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us', name: 'Anime News Network' },
  mal: { url: 'https://myanimelist.net/rss/news.xml', name: 'MyAnimeList' },
};
// On Netlify, /api/feed is a serverless function (netlify/functions/feed.mjs) that relays the
// RSS feeds so the browser avoids CORS. If it's unavailable (e.g. local dev) we try public proxies.
const feedSources = src => [
  `/api/feed?src=${src}`,
  `https://api.allorigins.win/raw?url=${encodeURIComponent(FEEDS[src].url)}`,
  `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(FEEDS[src].url)}`,
];

const CACHE_PREFIX = 'ata.cache.';

// ---------- small cache (localStorage, TTL-based) ----------
function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > maxAgeMs) return null;
    return v;
  } catch { return null; }
}
function cacheSet(key, value) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), v: value })); }
  catch {
    // Storage full: clear our cache entries and move on.
    try {
      Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX)).forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
  }
}

// ---------- AniList GraphQL ----------
const MEDIA_FIELDS = `
  id idMal siteUrl format status episodes averageScore popularity genres synonyms
  season seasonYear bannerImage
  title { romaji english native }
  coverImage { extraLarge large }
  startDate { year month day }
  nextAiringEpisode { airingAt episode }
  studios(isMain: true) { nodes { name } }`;

async function anilist(query, variables, { ttl = 60 * 60 * 1000, force = false } = {}) {
  const key = 'anilist:' + JSON.stringify(variables) + query.length;
  if (!force) {
    const hit = cacheGet(key, ttl);
    if (hit) return hit;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(ANILIST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.data) throw new Error(json?.errors?.[0]?.message || `AniList ${res.status}`);
    cacheSet(key, json.data);
    return json.data;
  }
  throw new Error('AniList rate limited');
}

// ---------- helpers ----------
export function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function stripHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function firstImageIn(html) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const img = doc.querySelector('img[src]');
  return img ? safeUrl(img.getAttribute('src')) : null;
}

const FORMAT = { TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' };
const STATUS = { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };

export function simplifyAnime(m) {
  const t = m.title || {};
  const sd = m.startDate || {};
  const airedFrom = sd.year && sd.month ? new Date(sd.year, sd.month - 1, sd.day || 1).toISOString() : null;
  return {
    id: m.id,
    title: t.english || t.romaji || t.native,
    titles: [t.english, t.romaji, t.native, ...(m.synonyms || [])].filter(Boolean),
    image: m.coverImage?.extraLarge || m.coverImage?.large || null,
    banner: m.bannerImage || null,
    url: m.siteUrl,
    score: m.averageScore ? m.averageScore / 10 : null,
    episodes: m.episodes,
    type: FORMAT[m.format] || m.format,
    status: STATUS[m.status] || m.status,
    genres: (m.genres || []).slice(0, 3),
    studios: (m.studios?.nodes || []).map(s => s.name),
    nextEpisode: m.nextAiringEpisode ? { at: m.nextAiringEpisode.airingAt * 1000, episode: m.nextAiringEpisode.episode } : null,
    airedFrom,
    datePrecision: sd.day ? 'day' : sd.month ? 'month' : sd.year ? 'year' : null,
    members: m.popularity || 0,
    season: m.season ? m.season.toLowerCase() : null,
    year: m.seasonYear || sd.year || null,
  };
}

// ---------- News: RSS feeds (ANN + MyAnimeList) ----------
export async function fetchFeed(src, { force = false } = {}) {
  const key = 'feed:' + src;
  if (!force) {
    const hit = cacheGet(key, 5 * 60 * 1000);
    if (hit) return hit;
  }
  let lastErr;
  for (const url of feedSources(src)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
      if (!res.ok) throw new Error(`${src} ${res.status}`);
      const items = parseRss(await res.text(), FEEDS[src].name);
      if (!items.length) throw new Error(`${src} feed empty`);
      cacheSet(key, items);
      return items;
    } catch (e) { lastErr = e; }
  }
  // Last resort: serve a stale copy rather than nothing.
  const stale = cacheGet(key, 7 * 24 * 60 * 60 * 1000);
  if (stale) return stale;
  throw lastErr || new Error(`${src} unavailable`);
}

export const fetchAllNews = opts => Promise.allSettled(Object.keys(FEEDS).map(src => fetchFeed(src, opts)));

function parseRss(xmlText, source) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  return [...doc.querySelectorAll('item')].map(item => {
    const get = sel => item.querySelector(sel)?.textContent?.trim() || '';
    const descHtml = get('description');
    const media = item.getElementsByTagNameNS('*', 'thumbnail')[0] || item.getElementsByTagNameNS('*', 'content')[0];
    const enclosure = item.querySelector('enclosure[type^="image"]');
    const mediaUrl = media?.getAttribute('url') || media?.textContent?.trim() || '';
    const image = safeUrl(mediaUrl || enclosure?.getAttribute('url') || '') || firstImageIn(descHtml);
    const date = new Date(get('pubDate') || get('date'));
    return {
      id: get('guid') || get('link'),
      title: stripHtml(get('title')),
      summary: stripHtml(descHtml),
      url: safeUrl(get('link').replace(/[?&]_location=rss$/, '')),
      image,
      date: isNaN(date) ? null : date.toISOString(),
      source,
      tags: [...item.querySelectorAll('category')].map(c => c.textContent.trim()).filter(Boolean),
    };
  }).filter(i => i.title && i.url);
}

// ---------- Anime lookups (AniList) ----------
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
export function seasonFor(date = new Date(), offset = 0) {
  let idx = Math.floor(date.getMonth() / 3) + offset;
  const year = date.getFullYear() + Math.floor(idx / 4);
  idx = ((idx % 4) + 4) % 4;
  return { season: SEASONS[idx], year };
}

export async function fetchSeason(which = 'now', { force = false } = {}) {
  const { season, year } = seasonFor(new Date(), which === 'now' ? 0 : 1);
  const query = `query ($season: MediaSeason, $year: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      media(season: $season, seasonYear: $year, type: ANIME, isAdult: false, sort: POPULARITY_DESC) { ${MEDIA_FIELDS} }
    }
  }`;
  const list = [];
  for (const page of [1, 2]) {
    const data = await anilist(query, { season, year, page }, { force });
    list.push(...(data.Page?.media || []).map(simplifyAnime));
    if (!data.Page?.pageInfo?.hasNextPage) break;
  }
  return { season: { season: season.toLowerCase(), year }, list };
}

export async function searchAnime(q) {
  const query = `query ($q: String) {
    Page(perPage: 6) {
      media(search: $q, type: ANIME, isAdult: false, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
    }
  }`;
  const data = await anilist(query, { q }, { ttl: 30 * 60 * 1000 });
  return (data.Page?.media || []).map(simplifyAnime);
}

// ---------- Weather: Open-Meteo ----------
export const DEFAULT_LOCATION = {
  name: 'Boca Raton',
  detail: 'FL · Florida Atlantic University',
  latitude: 26.3705,
  longitude: -80.1023,
  timezone: 'America/New_York',
};

export async function fetchWeather(loc) {
  const params = new URLSearchParams({
    latitude: loc.latitude,
    longitude: loc.longitude,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: loc.timezone || 'auto',
    forecast_days: '1',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather ${res.status}`);
  return res.json();
}

export async function geocode(name) {
  const params = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  if (!res.ok) throw new Error(`Geocoding ${res.status}`);
  const json = await res.json();
  return (json.results || []).map(r => ({
    name: r.name,
    detail: [r.admin1, r.country_code].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone,
  }));
}
