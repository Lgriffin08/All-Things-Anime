// Data layer: Anime News Network RSS, Jikan (MyAnimeList) API, and Open-Meteo weather.
// All sources are free and need no API key.

const JIKAN = 'https://api.jikan.moe/v4';
const ANN_RSS = 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us';
// On Netlify, /api/ann is proxied to the ANN feed (see netlify.toml) so the browser avoids CORS.
// Locally (or if the proxy fails) we fall back to a public CORS proxy.
const ANN_SOURCES = [
  '/api/ann',
  `https://api.allorigins.win/raw?url=${encodeURIComponent(ANN_RSS)}`,
  `https://corsproxy.io/?url=${encodeURIComponent(ANN_RSS)}`,
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

// ---------- Jikan request queue (rate limit: 3 req/s, 60 req/min) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let jikanChain = Promise.resolve();
let lastJikanCall = 0;

function jikan(path, { ttl = 10 * 60 * 1000, force = false } = {}) {
  const key = 'jikan:' + path;
  if (!force) {
    const hit = cacheGet(key, ttl);
    if (hit) return Promise.resolve(hit);
  }
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = 400 - (Date.now() - lastJikanCall);
      if (wait > 0) await sleep(wait);
      lastJikanCall = Date.now();
      const res = await fetch(JIKAN + path);
      if (res.status === 429) { await sleep(1200 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`Jikan ${res.status}`);
      const json = await res.json();
      cacheSet(key, json);
      return json;
    }
    throw new Error('Jikan rate limited');
  };
  const p = jikanChain.then(run, run);
  jikanChain = p.catch(() => {});
  return p;
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

function animeImage(a) {
  return a?.images?.webp?.large_image_url || a?.images?.jpg?.large_image_url ||
         a?.images?.webp?.image_url || a?.images?.jpg?.image_url || null;
}

export function simplifyAnime(a) {
  return {
    id: a.mal_id,
    title: a.title_english || a.title,
    altTitle: a.title_english && a.title !== a.title_english ? a.title : '',
    titles: [a.title, a.title_english, a.title_japanese, ...(a.title_synonyms || [])].filter(Boolean),
    image: animeImage(a),
    url: a.url,
    score: a.score,
    episodes: a.episodes,
    type: a.type,
    status: a.status,
    genres: (a.genres || []).map(g => g.name).slice(0, 3),
    studios: (a.studios || []).map(s => s.name),
    broadcast: a.broadcast?.string && a.broadcast.string !== 'Unknown' ? a.broadcast.string : '',
    airedFrom: a.aired?.from || null,
    members: a.members || 0,
    season: a.season, year: a.year,
  };
}

// ---------- News: Anime News Network RSS ----------
export async function fetchAnnNews({ force = false } = {}) {
  const key = 'ann';
  if (!force) {
    const hit = cacheGet(key, 5 * 60 * 1000);
    if (hit) return hit;
  }
  let lastErr;
  for (const src of ANN_SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(src, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`ANN ${res.status}`);
      const text = await res.text();
      const items = parseRss(text);
      if (!items.length) throw new Error('ANN feed empty');
      cacheSet(key, items);
      return items;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('ANN unavailable');
}

function parseRss(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) return [];
  return [...doc.querySelectorAll('item')].map(item => {
    const get = sel => item.querySelector(sel)?.textContent?.trim() || '';
    const descHtml = get('description');
    const media = item.getElementsByTagNameNS('*', 'thumbnail')[0] || item.getElementsByTagNameNS('*', 'content')[0];
    const enclosure = item.querySelector('enclosure[type^="image"]');
    const image = safeUrl(media?.getAttribute('url') || enclosure?.getAttribute('url') || '') || firstImageIn(descHtml);
    const date = new Date(get('pubDate') || get('date'));
    return {
      id: get('guid') || get('link'),
      title: stripHtml(get('title')),
      summary: stripHtml(descHtml),
      url: safeUrl(get('link')),
      image,
      date: isNaN(date) ? null : date.toISOString(),
      source: 'Anime News Network',
      tags: [...item.querySelectorAll('category')].map(c => c.textContent.trim()).filter(Boolean),
    };
  }).filter(i => i.title && i.url);
}

// ---------- News: MyAnimeList via Jikan ----------
export async function fetchAnimeNews(anime, { force = false } = {}) {
  const json = await jikan(`/anime/${anime.id}/news?page=1`, { force });
  return (json.data || []).map(n => ({
    id: n.url,
    title: n.title,
    summary: (n.excerpt || '').replace(/\s+/g, ' ').trim(),
    url: safeUrl(n.url),
    image: safeUrl(n.images?.jpg?.image_url || '') || anime.image,
    date: n.date,
    source: 'MyAnimeList',
    tags: [],
    anime: { id: anime.id, title: anime.title },
  })).filter(i => i.title && i.url);
}

// ---------- Anime lookups ----------
export async function fetchSeason(which = 'now', { force = false } = {}) {
  // Two pages gives a fuller lineup; dedupe because Jikan can repeat entries.
  const pages = [1, 2];
  const seen = new Set();
  const list = [];
  let season = null;
  for (const page of pages) {
    const json = await jikan(`/seasons/${which}?sfw=true&page=${page}`, { ttl: 60 * 60 * 1000, force });
    for (const a of json.data || []) {
      if (seen.has(a.mal_id)) continue;
      seen.add(a.mal_id);
      list.push(simplifyAnime(a));
      if (!season && a.season && a.year) season = { season: a.season, year: a.year };
    }
    if (!json.pagination?.has_next_page) break;
  }
  return { season, list };
}

export async function searchAnime(q) {
  const json = await jikan(`/anime?q=${encodeURIComponent(q)}&limit=6&sfw=true&order_by=members&sort=desc`, { ttl: 30 * 60 * 1000 });
  return (json.data || []).map(simplifyAnime);
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
