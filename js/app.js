import {
  fetchFeed, fetchSeason, searchAnime,
  fetchWeather, geocode, DEFAULT_LOCATION, safeUrl,
} from './api.js';
import * as auth from './auth.js';

const USER_NAME = 'Latrell';
const REFRESH_MS = 10 * 60 * 1000;     // auto-refresh feed + weather every 10 minutes
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Categories ----------
const CATEGORIES = [
  { id: 'all', label: 'All news', icon: '✨' },
  { id: 'announcements', label: 'Announcements', icon: '📣',
    re: /\b(announc\w*|green-?lit|gets? (a |new |tv |an )?(anime|sequel|film|movie|season)|new (tv )?anime|unveil\w*|reveal\w*|confirm\w*|sequel|adaptation|cast|staff|in production)\b/i },
  { id: 'release', label: 'Release dates', icon: '📅',
    re: /\b(premiere\w*|release date|releas\w*|debut\w*|air date|to air|airs|launch\w*|opens? (in|on)|starts? (airing|streaming)|(january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2})\b/i },
  { id: 'trailers', label: 'Trailers', icon: '🎬',
    re: /\b(trailers?|teasers?|PVs?|promo(tional)? videos?|videos?|commercials?|clips?|opening (theme|song|video)|ending (theme|song|video))\b/i },
  { id: 'delays', label: 'Delays', icon: '⏳',
    re: /\b(delay\w*|postpon\w*|hiatus|pushed back|reschedul\w*|cancel\w*|suspend\w*|on hold)\b/i },
  { id: 'streaming', label: 'Streaming', icon: '📺',
    re: /\b(stream\w*|simulcast\w*|crunchyroll|netflix|hidive|hulu|disney\s?\+|disney plus|prime video|amazon|funimation|adult swim|toonami|max|bilibili|ani-one|muse asia|tubi|dub(bed)?)\b/i },
  { id: 'industry', label: 'Industry', icon: '🏢',
    re: /\b(industry|studios? (acquir|merg|clos|layoff)\w*|box office|sales|revenue|earnings|ranking|acquir\w*|layoffs?|lawsuit|company|award\w*|convention|expo|festival|anime expo|charts?)\b/i },
];
// Priority for the single label shown on a card.
const PRIMARY_ORDER = ['delays', 'trailers', 'release', 'streaming', 'announcements', 'industry'];

const PLACEHOLDER_STYLE = {
  announcements: ['#ff5ca1', '#8f75ff'],
  release: ['#ff9f43', '#ff5ca1'],
  trailers: ['#8f75ff', '#39d0eb'],
  delays: ['#6c5ce7', '#2d3436'],
  streaming: ['#00b894', '#39d0eb'],
  industry: ['#636e72', '#8f75ff'],
  news: ['#e5357f', '#6d4cff'],
};

// ---------- State ----------
const state = {
  view: 'news',
  category: 'all',
  query: '',
  feed: [],              // merged base feed
  searchNews: [],        // extra news fetched for a search
  searchAnime: [],
  seasonNow: null,
  seasonUpcoming: null,
  seasonTab: 'now',
  watchlist: loadWatchlist(),
  animeIndex: new Map(), // id -> simplified anime (from seasonal/search)
  lastUpdated: null,
  loadingFeed: false,
  feedError: '',
  location: loadLocation(),
  user: null,
  profile: null,
};

// ---------- DOM ----------
const $ = sel => document.querySelector(sel);
const els = {
  greeting: $('#greeting'), greetingJp: $('#greetingJp'), greetingSub: $('#greetingSub'),
  weather: $('#weather'),
  searchForm: $('#searchForm'), searchInput: $('#searchInput'), searchClear: $('#searchClear'),
  chips: $('#categoryChips'), feedStatus: $('#feedStatus'), refreshBtn: $('#refreshBtn'),
  newsGrid: $('#newsGrid'), searchAnime: $('#searchAnime'),
  seasonGrid: $('#seasonGrid'), seasonTitle: $('#seasonTitle'),
  watchChips: $('#watchChips'), watchGrid: $('#watchGrid'), watchCount: $('#watchCount'),
  toast: $('#toast'),
  profileBody: $('#profileBody'),
  accountBtn: $('#accountBtn'), authDialog: $('#authDialog'), authBody: $('#authBody'),
};

// ---------- Utilities ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } }
function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function loadWatchlist() { const w = read('ata.watchlist.v2', []); return Array.isArray(w) ? w : []; }
function loadLocation() { const l = read('ata.location', null); return l && typeof l.latitude === 'number' ? l : DEFAULT_LOCATION; }

function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

const isNew = iso => iso && Date.now() - new Date(iso).getTime() < DAY_MS && Date.now() >= new Date(iso).getTime() - 60000;

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
}

function normalize(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

function matchesAnime(item, anime) {
  const hay = ' ' + normalize(item.title + ' ' + item.summary) + ' ';
  if (item.anime?.id === anime.id) return true;
  return (anime.titles || [anime.title]).some(t => {
    const n = normalize(t);
    return n.length >= 4 && hay.includes(' ' + n + ' ');
  });
}

function categorize(item) {
  const text = `${item.title} ${item.summary}`;
  const cats = new Set();
  for (const c of CATEGORIES) if (c.re && c.re.test(c.id === 'trailers' ? item.title : text)) cats.add(c.id);
  if ((item.tags || []).some(t => /industry/i.test(t))) cats.add('industry');
  const primary = PRIMARY_ORDER.find(id => cats.has(id)) || 'news';
  return { cats: [...cats], primary };
}

function dedupeSort(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.url || it.id || it.title).replace(/[?#].*$/, '').replace(/\/$/, '');
    const tkey = normalize(it.title);
    if (seen.has(key) || seen.has(tkey)) continue;
    seen.add(key); seen.add(tkey);
    out.push(it);
  }
  return out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

function enrich(items) {
  // Attach categories and, for ANN items without images, borrow artwork from a matching seasonal show.
  const shows = [...state.animeIndex.values()].filter(a => a.image);
  return items.map(it => {
    const out = { ...it, ...categorize(it) };
    if (!out.image) {
      const match = shows.find(a => matchesAnime(it, a));
      if (match) out.image = match.banner || match.image;
    }
    return out;
  });
}

function indexAnime(list) { for (const a of list) if (a?.id) state.animeIndex.set(a.id, a); }

// ---------- Greeting ----------
function renderGreeting() {
  const now = new Date();
  const h = now.getHours();
  let en, jp, emoji;
  if (h >= 5 && h < 12) { en = 'Good morning'; jp = 'おはよう'; emoji = '🌅'; }
  else if (h >= 12 && h < 18) { en = 'Good afternoon'; jp = 'こんにちは'; emoji = '☀️'; }
  else if (h >= 18 && h < 23) { en = 'Good evening'; jp = 'こんばんは'; emoji = '🌙'; }
  else { en = 'Up late'; jp = 'おつかれさま'; emoji = '🦉'; }
  els.greetingJp.textContent = `${jp} · ${emoji}`;
  const name = displayName() || USER_NAME;
  els.greeting.textContent = h >= 23 || h < 5 ? `${en}, ${name}? Night-owl mode on.` : `${en}, ${name}!`;
  const day = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  els.greetingSub.textContent = `It's ${day}. Here's everything new across the anime world: announcements, releases, trailers and more.`;
}

// ---------- Theme ----------
const media = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.dataset.themePref = pref;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#0f0d1a' : '#f7f5fc');
  document.querySelectorAll('[data-theme-choice]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.themeChoice === pref)));
}
function initTheme() {
  let pref = 'system';
  try { pref = localStorage.getItem('ata.theme') || 'system'; } catch { /* ignore */ }
  applyTheme(pref);
  document.querySelectorAll('[data-theme-choice]').forEach(btn => btn.addEventListener('click', () => {
    const p = btn.dataset.themeChoice;
    try { localStorage.setItem('ata.theme', p); } catch { /* ignore */ }
    applyTheme(p);
    toast(p === 'system' ? 'Theme follows your device' : `${p[0].toUpperCase() + p.slice(1)} theme on`);
  }));
  media.addEventListener('change', () => applyTheme(document.documentElement.dataset.themePref || 'system'));
}

// ---------- Weather ----------
const WMO = {
  0: ['Clear sky', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'], 56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'], 66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '🌨️'],
  80: ['Rain showers', '🌦️'], 81: ['Rain showers', '🌧️'], 82: ['Violent showers', '⛈️'], 85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm & hail', '⛈️'], 99: ['Thunderstorm & hail', '⛈️'],
};

let weatherMode = 'view'; // 'view' | 'edit'
async function loadWeather() {
  const loc = state.location;
  try {
    const data = await fetchWeather(loc);
    state.weatherData = data;
    state.weatherError = '';
  } catch (e) {
    state.weatherError = 'Weather is unavailable right now.';
  }
  if (weatherMode === 'view') renderWeather();
}

function renderWeather() {
  const loc = state.location;
  const isDefault = loc.latitude === DEFAULT_LOCATION.latitude && loc.longitude === DEFAULT_LOCATION.longitude;
  if (weatherMode === 'edit') {
    els.weather.innerHTML = `
      <div class="weather__desc">Change location</div>
      <form id="weatherForm">
        <input id="weatherInput" type="search" placeholder="City name…" aria-label="City name" required />
        <button class="btn btn--primary btn--sm" type="submit">Find</button>
      </form>
      <ul class="weather__results" id="weatherResults"></ul>
      <div class="weather__actions">
        <button type="button" data-weather="reset">📍 Boca Raton (FAU)</button>
        <button type="button" data-weather="cancel">Cancel</button>
      </div>`;
    $('#weatherInput').focus();
    return;
  }
  const d = state.weatherData;
  if (!d?.current) {
    els.weather.innerHTML = `<div class="weather__loading">${esc(state.weatherError || 'Loading weather…')}</div>
      <div class="weather__actions"><button type="button" data-weather="retry">Retry</button></div>`;
    return;
  }
  const c = d.current;
  const [desc, dayIcon, nightIcon] = WMO[c.weather_code] || ['—', '🌡️'];
  const icon = c.is_day ? dayIcon : (nightIcon || dayIcon);
  const hi = d.daily?.temperature_2m_max?.[0];
  const lo = d.daily?.temperature_2m_min?.[0];
  const rain = d.daily?.precipitation_probability_max?.[0];
  els.weather.innerHTML = `
    <div class="weather__top">
      <div class="weather__icon" aria-hidden="true">${icon}</div>
      <div>
        <div class="weather__temp">${Math.round(c.temperature_2m)}°F</div>
        <div class="weather__desc">${esc(desc)}</div>
      </div>
    </div>
    <div class="weather__place">📍 ${esc(loc.name)}${loc.detail ? ' · ' + esc(loc.detail) : ''}</div>
    <div class="weather__details">
      ${hi != null ? `<span>H ${Math.round(hi)}° / L ${Math.round(lo)}°</span>` : ''}
      <span>Feels ${Math.round(c.apparent_temperature)}°</span>
      <span>💧 ${Math.round(c.relative_humidity_2m)}%</span>
      <span>💨 ${Math.round(c.wind_speed_10m)} mph</span>
      ${rain != null ? `<span>☔ ${rain}%</span>` : ''}
    </div>
    <div class="weather__actions">
      <button type="button" data-weather="edit">Change location</button>
      ${isDefault ? '' : '<button type="button" data-weather="reset">Back to Boca</button>'}
    </div>`;
}

function initWeather() {
  els.weather.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-weather], button[data-loc]');
    if (!btn) return;
    const action = btn.dataset.weather;
    if (action === 'edit') { weatherMode = 'edit'; renderWeather(); }
    else if (action === 'cancel') { weatherMode = 'view'; renderWeather(); }
    else if (action === 'retry') { renderWeather(); loadWeather(); }
    else if (action === 'reset') { setLocation(DEFAULT_LOCATION); }
    else if (btn.dataset.loc) {
      const loc = state.geoResults?.[Number(btn.dataset.loc)];
      if (loc) setLocation(loc);
    }
  });
  els.weather.addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#weatherInput')?.value.trim();
    const list = $('#weatherResults');
    if (!q || !list) return;
    list.innerHTML = '<li class="muted">Searching…</li>';
    try {
      state.geoResults = await geocode(q);
      list.innerHTML = state.geoResults.length
        ? state.geoResults.map((r, i) => `<li><button type="button" data-loc="${i}">${esc(r.name)}<span class="muted">${r.detail ? ' · ' + esc(r.detail) : ''}</span></button></li>`).join('')
        : '<li class="muted">No places found.</li>';
    } catch {
      list.innerHTML = '<li class="muted">Search failed. Try again.</li>';
    }
  });
}

function setLocation(loc) {
  state.location = loc;
  store('ata.location', loc);
  weatherMode = 'view';
  state.weatherData = null;
  renderWeather();
  loadWeather();
}

// ---------- News feed ----------
function skeletons(n = 6) {
  return Array.from({ length: n }, () => `
    <div class="card skeleton" aria-hidden="true">
      <div class="card__media"></div>
      <div class="card__body">
        <div class="sk-line" style="width:90%"></div><div class="sk-line" style="width:70%"></div>
        <div class="sk-line" style="width:100%;margin-top:8px"></div><div class="sk-line" style="width:80%"></div>
      </div>
    </div>`).join('');
}

function newsCard(it) {
  const cat = CATEGORIES.find(c => c.id === it.primary);
  const catLabel = cat ? `${cat.icon} ${cat.label}` : '📰 News';
  const [g1, g2] = PLACEHOLDER_STYLE[it.primary] || PLACEHOLDER_STYLE.news;
  const img = safeUrl(it.image || '');
  const url = safeUrl(it.url);
  const date = it.date ? new Date(it.date) : null;
  const media = img
    ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${esc(catLabel)}" data-g="${g1},${g2}" />`
    : placeholder(catLabel, g1, g2);
  return `
    <article class="card">
      <div class="card__media">
        ${media}
        ${isNew(it.date) ? '<span class="badge-new">NEW</span>' : ''}
        <span class="card__cat">${esc(catLabel)}</span>
      </div>
      <div class="card__body">
        <h3 class="card__title"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
        ${it.summary ? `<p class="card__summary">${esc(it.summary)}</p>` : ''}
        <div class="card__foot">
          <span><span class="card__source">${esc(it.source)}</span>${date ? ` · <time datetime="${esc(it.date)}" title="${esc(date.toLocaleString())}">${esc(timeAgo(it.date))}</time>` : ''}</span>
          <a class="card__link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="Read full article: ${esc(it.title)}">Read →</a>
        </div>
      </div>
    </article>`;
}

function placeholder(label, g1, g2) {
  const [icon, ...rest] = label.split(' ');
  return `<div class="card__placeholder" style="background:linear-gradient(135deg,${g1},${g2})"><div><span aria-hidden="true">${icon}</span>${esc(rest.join(' '))}</div></div>`;
}

// Swap broken images for a gradient placeholder.
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
  const [g1, g2] = (img.dataset.g || '').split(',');
  img.outerHTML = placeholder(img.dataset.fallback, g1 || '#e5357f', g2 || '#6d4cff');
}, true);

function emptyState(icon, title, text, action = '') {
  return `<div class="empty"><div class="empty__icon" aria-hidden="true">${icon}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

function currentNewsList() {
  let items = state.feed;
  if (state.query) {
    const q = normalize(state.query);
    const words = q.split(' ').filter(Boolean);
    const local = items.filter(it => {
      const hay = normalize(`${it.title} ${it.summary} ${it.anime?.title || ''}`);
      return words.every(w => hay.includes(w));
    });
    items = dedupeSort([...local, ...state.searchNews]);
  }
  return items;
}

function renderChips(items) {
  const counts = Object.fromEntries(CATEGORIES.map(c => [c.id, 0]));
  counts.all = items.length;
  for (const it of items) for (const c of it.cats || []) counts[c] = (counts[c] || 0) + 1;
  els.chips.innerHTML = CATEGORIES.map(c => `
    <button type="button" class="chip" role="tab" data-cat="${c.id}" aria-selected="${state.category === c.id}">
      <span aria-hidden="true">${c.icon}</span> ${esc(c.label)}<span class="chip__n">${counts[c.id] || 0}</span>
    </button>`).join('');
}

function renderNews() {
  const base = currentNewsList();
  renderChips(base);
  const items = state.category === 'all' ? base : base.filter(it => (it.cats || []).includes(state.category));

  if (state.loadingFeed && !state.feed.length) {
    els.newsGrid.innerHTML = skeletons();
    els.newsGrid.setAttribute('aria-busy', 'true');
  } else {
    els.newsGrid.setAttribute('aria-busy', 'false');
    if (items.length) {
      els.newsGrid.innerHTML = items.map(newsCard).join('');
    } else if (state.feedError && !state.feed.length) {
      els.newsGrid.innerHTML = emptyState('📡', "Couldn't load the news", state.feedError, '<button type="button" class="btn btn--primary" data-action="refresh">Try again</button>');
    } else if (state.query) {
      els.newsGrid.innerHTML = emptyState('🔍', `No recent news for “${state.query}”`,
        'The feed covers the latest stories from Anime News Network and MyAnimeList. For older coverage, search the archives:',
        `<div class="empty__links">${archiveLinks(state.searchAnime[0]?.title || state.query)}</div>`);
    } else {
      els.newsGrid.innerHTML = emptyState('🗂️', 'Nothing in this category yet', 'Check back soon, or browse all news.', '<button type="button" class="chip" data-cat="all">Show all news</button>');
    }
  }
  renderFeedStatus(items.length);
}

function renderFeedStatus(count) {
  const newCount = currentNewsList().filter(it => isNew(it.date)).length;
  const parts = [];
  if (state.loadingFeed) parts.push('Updating…');
  if (state.query) parts.push(`${count} result${count === 1 ? '' : 's'} for “${state.query}”`);
  else if (state.feed.length) parts.push(`${count} stories`);
  if (newCount && !state.query) parts.push(`${newCount} new today`);
  if (state.lastUpdated && !state.loadingFeed) parts.push(`updated ${timeAgo(state.lastUpdated.toISOString())}`);
  els.feedStatus.textContent = parts.join(' · ');
  els.refreshBtn.disabled = state.loadingFeed;
  els.refreshBtn.firstElementChild.classList.toggle('spin', state.loadingFeed);
}

async function loadFeed({ force = false } = {}) {
  if (state.loadingFeed) return;
  state.loadingFeed = true;
  state.feedError = '';
  renderNews();

  // ANN + MAL news feeds and the seasonal list (used for artwork matching) all load in parallel.
  const parts = { ann: [], mal: [] };
  const merge = () => { state.feed = dedupeSort(enrich([...parts.ann, ...parts.mal])); renderNews(); };
  const feedPs = Object.keys(parts).map(src => fetchFeed(src, { force })
    .then(items => { parts[src] = items; merge(); })
    .catch(() => {}));
  const seasonP = (state.seasonNow ? Promise.resolve(state.seasonNow) : fetchSeason('now'))
    .then(data => { state.seasonNow = data; indexAnime(data.list); })
    .catch(() => {});

  await Promise.all([...feedPs, seasonP]);

  state.feed = dedupeSort(enrich([...parts.ann, ...parts.mal]));
  state.loadingFeed = false;
  if (!state.feed.length) state.feedError = 'The news sources did not respond. Check your connection and try again.';
  else state.lastUpdated = new Date();
  renderNews();
  if (state.view === 'seasonal') renderSeason();
  if (state.view === 'watchlist') renderWatchlist();
}

// ---------- Search ----------
let searchToken = 0;
async function runSearch(q) {
  q = q.trim();
  state.query = q;
  state.category = 'all';
  state.searchNews = [];
  state.searchAnime = [];
  els.searchClear.hidden = !q;
  if (location.hash !== '#news') location.hash = '#news';
  renderNews();
  renderSearchAnime();
  if (!q) return;

  const token = ++searchToken;
  els.searchAnime.hidden = false;
  els.searchAnime.innerHTML = '<span class="anime-strip__label">Looking up anime…</span>';
  try {
    const found = await searchAnime(q);
    if (token !== searchToken) return;
    state.searchAnime = found;
    indexAnime(found);
    renderSearchAnime();
    // Include stories that mention any title or alias of the best matches (English, romaji, Japanese).
    state.searchNews = state.feed.filter(it => found.slice(0, 3).some(a => matchesAnime(it, a)));
    renderNews();
  } catch {
    if (token !== searchToken) return;
    els.searchAnime.innerHTML = '<span class="anime-strip__label">Anime lookup is unavailable right now. These results only search the latest headlines.</span>';
  }
}

function renderSearchAnime() {
  if (!state.query || !state.searchAnime.length) {
    els.searchAnime.hidden = !state.query;
    if (!state.query) els.searchAnime.innerHTML = '';
    else if (!state.searchAnime.length && !els.searchAnime.innerHTML.includes('Looking')) els.searchAnime.hidden = true;
    return;
  }
  els.searchAnime.hidden = false;
  els.searchAnime.innerHTML = `<span class="anime-strip__label">Matching anime</span>` + state.searchAnime.map(a => `
    <div class="mini">
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
      <div>
        <div class="mini__title">${esc(a.title)}</div>
        <div class="mini__meta">${esc([a.type, a.year, a.status].filter(Boolean).join(' · '))}</div>
        ${followButton(a, true)}
      </div>
    </div>`).join('');
}

function initSearch() {
  let t;
  els.searchForm.addEventListener('submit', e => {
    e.preventDefault();
    clearTimeout(t);
    runSearch(els.searchInput.value);
    els.searchInput.blur();
  });
  els.searchInput.addEventListener('input', () => {
    els.searchClear.hidden = !els.searchInput.value;
    clearTimeout(t);
    // Instant local filtering while typing; the full lookup runs on submit.
    t = setTimeout(() => {
      const q = els.searchInput.value.trim();
      if (!q) { runSearch(''); return; }
      if (q === state.query) return;
      searchToken++; // cancel any in-flight full lookup
      state.query = q;
      state.searchNews = [];
      state.searchAnime = [];
      els.searchAnime.hidden = true;
      renderNews();
    }, 200);
  });
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = '';
    runSearch('');
    els.searchInput.focus();
  });
}

function archiveLinks(title) {
  const q = encodeURIComponent(title);
  return `<p class="empty__link-row"><b>${esc(title)}</b>
    <a href="https://www.animenewsnetwork.com/search?q=${q}" target="_blank" rel="noopener noreferrer">ANN archive ↗</a>
    <a href="https://myanimelist.net/news/search?q=${q}" target="_blank" rel="noopener noreferrer">MAL news ↗</a></p>`;
}

// ---------- Watchlist ----------
const isFollowing = id => state.watchlist.some(w => w.id === id);

function followButton(a, small = false) {
  const on = isFollowing(a.id);
  return `<button type="button" class="btn ${on ? 'btn--ghost is-following' : 'btn--ghost'} ${small ? 'btn--sm' : 'btn--sm'}" data-follow="${a.id}" aria-pressed="${on}">
    ${on ? '★ Following' : '☆ Follow'}</button>`;
}

async function toggleFollow(id) {
  id = Number(id);
  const before = state.watchlist;
  let added = null;
  if (isFollowing(id)) {
    const a = state.watchlist.find(w => w.id === id);
    state.watchlist = state.watchlist.filter(w => w.id !== id);
    toast(`Removed ${a?.title || 'show'} from your watchlist`);
  } else {
    const a = state.animeIndex.get(id);
    if (!a) return;
    added = { id: a.id, title: a.title, image: a.image, titles: a.titles };
    state.watchlist = [...state.watchlist, added];
    toast(`Following ${a.title} ★`);
  }
  watchlistChanged();
  if (!state.user) return;
  // Signed in: save to the account (optimistic update, rolled back on failure).
  try {
    if (added) await auth.saveWatchItems([added]);
    else await auth.removeWatchItem(id);
  } catch (e) {
    state.watchlist = before;
    watchlistChanged();
    toast(`Couldn't save to your account: ${e.message}`);
  }
}

function watchlistChanged() {
  if (!state.user) store('ata.watchlist.v2', state.watchlist);
  updateFollowButtons();
  renderWatchCount();
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'profile') renderProfile();
}

function updateFollowButtons() {
  document.querySelectorAll('[data-follow]').forEach(btn => {
    const on = isFollowing(Number(btn.dataset.follow));
    btn.classList.toggle('is-following', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? '★ Following' : '☆ Follow';
  });
}

function renderWatchCount() {
  const n = state.watchlist.length;
  els.watchCount.hidden = !n;
  els.watchCount.textContent = n;
}

function renderWatchlist() {
  const list = state.watchlist;
  els.watchChips.innerHTML = list.map(a => `
    <span class="watch-chip">
      ${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}
      ${esc(a.title)}
      <button type="button" data-unfollow="${a.id}" aria-label="Unfollow ${esc(a.title)}">✕</button>
    </span>`).join('');

  if (!list.length) {
    els.watchGrid.innerHTML = emptyState('⭐', 'Your watchlist is empty', 'Follow shows from the Seasonal lineup or from search results to get news about only them.',
      '<a class="btn btn--primary" href="#seasonal">Browse this season</a>');
    return;
  }

  const items = dedupeSort(enrich(state.feed.filter(it => list.some(a => matchesAnime(it, a)))));
  if (items.length) {
    els.watchGrid.innerHTML = items.map(newsCard).join('');
  } else if (state.loadingFeed && !state.feed.length) {
    els.watchGrid.innerHTML = skeletons(3);
  } else {
    els.watchGrid.innerHTML = emptyState('🕊️', 'No recent news for your shows',
      'We check Anime News Network and MyAnimeList every 10 minutes, so new stories will show up here. You can also dig through the archives:',
      `<div class="empty__links">${list.map(a => archiveLinks(a.title)).join('')}</div>`);
  }
}

// ---------- Seasonal ----------
function seasonLabel(s) {
  if (!s) return '';
  return `${s.season[0].toUpperCase()}${s.season.slice(1)} ${s.year}`;
}

function animeCard(a, upcoming) {
  const premiere = a.airedFrom && a.datePrecision !== 'year'
    ? new Date(a.airedFrom).toLocaleDateString(undefined, a.datePrecision === 'day' ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'long', year: 'numeric' })
    : null;
  const next = a.nextEpisode
    ? `Ep ${a.nextEpisode.episode} ${new Date(a.nextEpisode.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : null;
  const meta = upcoming
    ? [a.type, premiere ? `Premieres ${premiere}` : 'Date TBA']
    : [a.type, a.episodes ? `${a.episodes} eps` : null, next];
  return `
    <article class="anime">
      <div class="anime__poster">
        ${a.image ? `<img src="${esc(a.image)}" alt="${esc(a.title)} poster" loading="lazy" referrerpolicy="no-referrer" />` : ''}
        ${a.score ? `<span class="anime__score">★ ${a.score.toFixed(2)}</span>` : ''}
      </div>
      <div class="anime__body">
        <h3 class="anime__title"><a href="${esc(safeUrl(a.url) || '#')}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a></h3>
        <div class="anime__meta">${esc(meta.filter(Boolean).join(' · '))}</div>
        ${a.genres.length ? `<div class="anime__genres">${a.genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
        <div class="anime__actions">
          ${followButton(a)}
          <button type="button" class="btn btn--ghost btn--sm" data-news-for="${esc(a.title)}" title="Search news about ${esc(a.title)}">📰 News</button>
        </div>
      </div>
    </article>`;
}

async function renderSeason() {
  const tab = state.seasonTab;
  document.querySelectorAll('[data-season]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.season === tab)));
  const key = tab === 'now' ? 'seasonNow' : 'seasonUpcoming';
  if (!state[key]) {
    els.seasonGrid.setAttribute('aria-busy', 'true');
    els.seasonGrid.innerHTML = Array.from({ length: 8 }, () => '<div class="anime skeleton"><div class="anime__poster card__media"></div><div class="anime__body"><div class="sk-line"></div><div class="sk-line" style="width:60%"></div></div></div>').join('');
    try {
      state[key] = await fetchSeason(tab);
      indexAnime(state[key].list);
    } catch {
      if (state.seasonTab !== tab) return;
      els.seasonGrid.innerHTML = emptyState('📡', "Couldn't load the seasonal lineup", 'The anime database may be busy. Give it a moment.', '<button type="button" class="btn btn--primary" data-action="season-retry">Try again</button>');
      return;
    }
    if (state.seasonTab !== tab) return;
  }
  const { list, season } = state[key];
  els.seasonGrid.setAttribute('aria-busy', 'false');
  els.seasonTitle.textContent = tab === 'now'
    ? `Airing Now${season ? ' · ' + seasonLabel(season) : ''}`
    : `Coming Next${season ? ' · ' + seasonLabel(season) : ''}`;
  const sorted = [...list].sort((a, b) => b.members - a.members);
  els.seasonGrid.innerHTML = sorted.length ? sorted.map(a => animeCard(a, tab === 'upcoming')).join('')
    : emptyState('🌸', 'No shows listed yet', 'Check back soon.');
}

// ---------- Account (Supabase email login) ----------
const initialHash = location.hash; // read before Supabase consumes auth tokens in the URL
let authMode = 'signin';

function displayName() {
  const u = state.user;
  if (!u) return '';
  return (state.profile?.display_name || '').trim() || (u.user_metadata?.first_name || '').trim() || u.email.split('@')[0];
}

function avatarHtml(cls = '') {
  const url = safeUrl(state.profile?.avatar_url || '');
  if (url) return `<img class="avatar-img ${cls}" src="${esc(url)}" alt="" />`;
  return esc(displayName()[0]?.toUpperCase() || '★');
}

function renderAccountButton() {
  const label = els.accountBtn.querySelector('.account-btn__label');
  const avatar = els.accountBtn.querySelector('.account-btn__avatar');
  if (state.user) {
    const name = displayName();
    els.accountBtn.classList.add('is-signed-in');
    avatar.innerHTML = avatarHtml();
    label.textContent = name;
    els.accountBtn.setAttribute('aria-label', `Account: ${state.user.email}`);
  } else {
    els.accountBtn.classList.remove('is-signed-in');
    avatar.textContent = '👤';
    label.textContent = 'Sign in';
    els.accountBtn.setAttribute('aria-label', 'Sign in');
  }
}

function openAuth(mode) {
  authMode = mode || (state.user ? 'account' : 'signin');
  renderAuth();
  if (!els.authDialog.open) els.authDialog.showModal();
  els.authBody.querySelector('input')?.focus();
}

function closeAuth() { if (els.authDialog.open) els.authDialog.close(); }

function authMessage(text, kind = 'error') {
  const box = els.authBody.querySelector('[data-auth-msg]');
  if (!box) return;
  box.hidden = !text;
  box.className = `auth-msg auth-msg--${kind}`;
  box.textContent = text || '';
}

function renderAuth() {
  const email = esc(els.authBody.querySelector('input[name="email"]')?.value || '');
  const msg = '<p class="auth-msg" data-auth-msg role="alert" hidden></p>';
  const tabs = `
    <div class="auth-tabs" role="tablist">
      <button type="button" role="tab" data-auth-mode="signin" aria-selected="${authMode === 'signin'}">Sign in</button>
      <button type="button" role="tab" data-auth-mode="signup" aria-selected="${authMode === 'signup'}">Create account</button>
    </div>`;
  const emailField = `<label class="auth-field">Email<input name="email" type="email" autocomplete="email" required value="${email}" /></label>`;
  let html = '';
  if (authMode === 'signin') {
    html = `<h2 id="authTitle">Welcome back</h2><p class="auth-sub">Sign in to keep your watchlist on every device.</p>${tabs}
      <form class="auth-form" data-auth-form="signin">
        ${emailField}
        <label class="auth-field">Password<input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="button" class="auth-link" data-auth-mode="forgot">Forgot password?</button>
        ${msg}
        <button type="submit" class="btn btn--primary">Sign in</button>
      </form>`;
  } else if (authMode === 'signup') {
    html = `<h2 id="authTitle">Create your account</h2><p class="auth-sub">Save your watchlist and pick up where you left off anywhere.</p>${tabs}
      <form class="auth-form" data-auth-form="signup">
        <label class="auth-field">First name <small>(optional, for your greeting)</small><input name="firstName" type="text" autocomplete="given-name" maxlength="40" /></label>
        ${emailField}
        <label class="auth-field">Password <small>At least 6 characters</small><input name="password" type="password" autocomplete="new-password" minlength="6" required /></label>
        ${msg}
        <button type="submit" class="btn btn--primary">Create account</button>
      </form>`;
  } else if (authMode === 'forgot') {
    html = `<h2 id="authTitle">Reset your password</h2><p class="auth-sub">Enter your email and we'll send you a link to set a new password.</p>
      <form class="auth-form" data-auth-form="forgot">
        ${emailField}
        ${msg}
        <button type="submit" class="btn btn--primary">Send reset link</button>
        <button type="button" class="auth-link" data-auth-mode="signin">← Back to sign in</button>
      </form>`;
  } else if (authMode === 'recovery') {
    html = `<h2 id="authTitle">Set a new password</h2><p class="auth-sub">Choose a new password for ${esc(state.user?.email || 'your account')}.</p>
      <form class="auth-form" data-auth-form="recovery">
        <label class="auth-field">New password <small>At least 6 characters</small><input name="password" type="password" autocomplete="new-password" minlength="6" required /></label>
        ${msg}
        <button type="submit" class="btn btn--primary">Save new password</button>
      </form>`;
  } else if (authMode === 'account' && state.user) {
    const n = state.watchlist.length;
    html = `<h2 id="authTitle">Your account</h2><p class="auth-sub">Your watchlist is saved to your account.</p>
      <div class="auth-account">
        <div class="auth-account__row">
          <span class="account-btn__avatar" aria-hidden="true">${avatarHtml()}</span>
          <div><div class="auth-account__name">${esc(displayName())}${state.profile?.username ? ` <span class="muted">@${esc(state.profile.username)}</span>` : ''}</div><div class="auth-account__email">${esc(state.user.email)}</div><div class="muted">${n} show${n === 1 ? '' : 's'} on your watchlist</div></div>
        </div>
        ${msg}
        <a class="btn btn--primary" href="#profile" data-auth-close>✏️ View &amp; edit profile</a>
        <button type="button" class="btn btn--ghost" data-auth-mode="recovery">Change password</button>
        <button type="button" class="btn btn--ghost" data-auth-action="signout">Sign out</button>
      </div>`;
  }
  els.authBody.innerHTML = html;
}

async function handleAuthSubmit(form) {
  const kind = form.dataset.authForm;
  const data = Object.fromEntries(new FormData(form));
  const email = (data.email || '').trim();
  const btn = form.querySelector('button[type="submit"]');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Please wait…';
  authMessage('');
  try {
    if (kind === 'signin') {
      await auth.signIn(email, data.password);
      closeAuth();
    } else if (kind === 'signup') {
      const { needsConfirmation } = await auth.signUp(email, data.password, (data.firstName || '').trim());
      if (needsConfirmation) {
        form.reset();
        authMessage(`Almost done! We sent a confirmation link to ${email}. Click it to finish creating your account.`, 'ok');
      } else closeAuth();
    } else if (kind === 'forgot') {
      await auth.sendPasswordReset(email);
      authMessage(`If an account exists for ${email}, a reset link is on its way.`, 'ok');
    } else if (kind === 'recovery') {
      await auth.updatePassword(data.password);
      closeAuth();
      toast('Password updated ✓');
    }
  } catch (e) {
    authMessage(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Merge any shows followed while signed out into the account, then use the account's list.
async function syncWatchlist() {
  const guest = loadWatchlist();
  try {
    const remote = await auth.fetchWatchlist();
    const missing = guest.filter(g => !remote.some(r => r.id === g.id));
    if (missing.length) {
      await auth.saveWatchItems(missing);
      toast(`Added ${missing.length} show${missing.length === 1 ? '' : 's'} to your account's watchlist`);
    }
    store('ata.watchlist.v2', []); // guest list now lives in the account
    state.watchlist = [...remote, ...missing];
  } catch (e) {
    toast(`Couldn't load your saved watchlist: ${e.message}`);
  }
  watchlistChanged();
}

function onAuthChange(event, session) {
  const prevId = state.user?.id;
  state.user = session?.user || null;
  renderAccountButton();
  renderGreeting();
  if (event === 'PASSWORD_RECOVERY') { openAuth('recovery'); return; }
  if (state.user && state.user.id !== prevId) {
    if (event === 'SIGNED_IN' && prevId === undefined && !/type=(signup|magiclink|recovery)/.test(initialHash)) {
      toast(`Signed in as ${state.user.email}`);
    }
    syncWatchlist();
    loadProfile();
  } else if (!state.user && prevId) {
    state.profile = null;
    profileDraft = null;
    if (state.view === 'profile') renderProfile();
    state.watchlist = loadWatchlist();
    watchlistChanged();
    toast('Signed out');
  }
  if (els.authDialog.open && authMode === 'account') renderAuth();
}

function initAccount() {
  renderAccountButton();
  els.accountBtn.addEventListener('click', () => openAuth());
  els.authDialog.addEventListener('click', e => {
    if (e.target === els.authDialog) { closeAuth(); return; } // backdrop click
    const t = e.target.closest('[data-auth-mode], [data-auth-close], [data-auth-action]');
    if (!t) return;
    if (t.dataset.authMode) { authMode = t.dataset.authMode; renderAuth(); els.authBody.querySelector('input')?.focus(); }
    else if ('authClose' in t.dataset) closeAuth();
    else if (t.dataset.authAction === 'signout') {
      auth.signOut().then(closeAuth).catch(e => authMessage(e.message));
    }
  });
  els.authDialog.addEventListener('submit', e => {
    e.preventDefault();
    handleAuthSubmit(e.target);
  });

  // Messages for links clicked in auth emails.
  const params = new URLSearchParams(initialHash.replace(/^#/, ''));
  if (params.get('error_description')) {
    const expired = /expired|invalid/i.test(params.get('error_code') || params.get('error_description'));
    toast(expired ? 'That email link has expired. Please request a new one.' : params.get('error_description'));
    history.replaceState(null, '', location.pathname + location.search);
  } else if (params.get('type') === 'signup') {
    setTimeout(() => toast('Email confirmed! You’re signed in 🎉'), 400);
  }

  auth.initAuth(onAuthChange).catch(() => {
    els.accountBtn.title = 'Sign-in is unavailable right now';
  });
}

// ---------- Profile ----------
const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music',
  'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
const MAX_GENRES = 10;
let profileDraft = null;   // unsaved edits
let profileLoading = false;
let profileError = '';

async function loadProfile() {
  profileLoading = true;
  profileError = '';
  if (state.view === 'profile') renderProfile();
  try {
    state.profile = await auth.getProfile();
  } catch (e) {
    profileError = e.message;
  }
  profileLoading = false;
  renderAccountButton();
  renderGreeting();
  if (state.view === 'profile') renderProfile();
  if (els.authDialog.open && authMode === 'account') renderAuth();
}

function memberSince(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
}

function renderProfile() {
  if (!state.user) {
    els.profileBody.innerHTML = emptyState('🪪', 'Create your anime profile',
      'Sign in or create a free account to set up your profile with a photo, bio and favorite genres.',
      '<button type="button" class="btn btn--primary" data-action="signin">Sign in or create account</button>');
    return;
  }
  if (!state.profile) {
    els.profileBody.innerHTML = profileError
      ? emptyState('⚠️', "Couldn't load your profile", profileError, '<button type="button" class="btn btn--primary" data-action="profile-retry">Try again</button>')
      : '<div class="profile-card skeleton"><div class="sk-line" style="width:40%;height:20px"></div><div class="sk-line" style="width:70%;margin-top:12px"></div></div>';
    return;
  }
  const p = state.profile;
  const d = profileDraft || (profileDraft = {
    display_name: p.display_name || '', username: p.username || '', bio: p.bio || '',
    favorite_anime: p.favorite_anime || '', favorite_genres: [...(p.favorite_genres || [])],
  });
  const genres = p.favorite_genres || [];
  const watchTitles = [...new Set(state.watchlist.map(w => w.title))];
  els.profileBody.innerHTML = `
    <div class="profile-layout">
      <article class="profile-card profile-card--summary">
        <div class="profile-cover" aria-hidden="true"></div>
        <div class="profile-avatar" id="profileAvatar">${avatarHtml()}</div>
        <h2 class="profile-name">${esc(displayName())}</h2>
        ${p.username ? `<p class="profile-handle">@${esc(p.username)}</p>` : '<p class="profile-handle muted">No username yet</p>'}
        ${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>` : '<p class="profile-bio muted">Add a bio to tell other fans about yourself.</p>'}
        <dl class="profile-stats">
          <div><dt>Watchlist</dt><dd>${state.watchlist.length}</dd></div>
          <div><dt>Favorite</dt><dd>${p.favorite_anime ? esc(p.favorite_anime) : '—'}</dd></div>
          <div><dt>Member since</dt><dd>${esc(memberSince(p.created_at))}</dd></div>
        </dl>
        ${genres.length ? `<div class="profile-genres">${genres.map(g => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
      </article>

      <form class="profile-card profile-form" id="profileForm" novalidate>
        <h2>Edit profile</h2>

        <div class="profile-photo">
          <div class="profile-avatar profile-avatar--sm">${avatarHtml()}</div>
          <div class="profile-photo__actions">
            <label class="btn btn--ghost btn--sm">📷 ${p.avatar_url ? 'Change photo' : 'Upload photo'}
              <input type="file" accept="image/png,image/jpeg,image/webp" data-profile-photo hidden />
            </label>
            ${p.avatar_url ? '<button type="button" class="btn btn--ghost btn--sm" data-profile-action="remove-photo">Remove</button>' : ''}
            <small class="muted">JPG, PNG or WebP. We'll crop it to a square.</small>
          </div>
        </div>

        <label class="auth-field">Display name
          <input name="display_name" maxlength="40" value="${esc(d.display_name)}" placeholder="${esc((state.user.user_metadata?.first_name || '').trim() || 'Your name')}" />
          <small>Used in your greeting. Up to 40 characters.</small>
        </label>

        <label class="auth-field">Username
          <div class="input-prefix"><span>@</span><input name="username" maxlength="20" value="${esc(d.username)}" placeholder="otaku_owl" autocapitalize="none" autocomplete="username" spellcheck="false" /></div>
          <small>3–20 characters: lowercase letters, numbers and underscores.</small>
        </label>

        <label class="auth-field">Bio
          <textarea name="bio" rows="3" maxlength="280" placeholder="What are you watching this season?">${esc(d.bio)}</textarea>
          <small><span data-bio-count>${d.bio.length}</span>/280</small>
        </label>

        <label class="auth-field">Favorite anime of all time
          <input name="favorite_anime" maxlength="100" value="${esc(d.favorite_anime)}" list="favAnimeOptions" placeholder="e.g. Fullmetal Alchemist: Brotherhood" />
          <datalist id="favAnimeOptions">${watchTitles.map(t => `<option value="${esc(t)}"></option>`).join('')}</datalist>
        </label>

        <fieldset class="auth-field profile-genre-picker">
          <legend>Favorite genres <small>(up to ${MAX_GENRES})</small></legend>
          <div class="chips chips--wrap">
            ${GENRES.map(g => `<button type="button" class="chip" data-genre="${esc(g)}" aria-pressed="${d.favorite_genres.includes(g)}">${esc(g)}</button>`).join('')}
          </div>
        </fieldset>

        <p class="auth-msg" data-profile-msg role="alert" hidden></p>
        <div class="profile-form__actions">
          <button type="button" class="btn btn--ghost" data-profile-action="reset">Discard changes</button>
          <button type="submit" class="btn btn--primary">Save profile</button>
        </div>
      </form>
    </div>`;
}

function profileMessage(text, kind = 'error') {
  const box = els.profileBody.querySelector('[data-profile-msg]');
  if (!box) return toast(text);
  box.hidden = !text;
  box.className = `auth-msg auth-msg--${kind}`;
  box.textContent = text || '';
}

function validateProfile(d) {
  if (d.username && !/^[a-z0-9_]{3,20}$/.test(d.username)) return 'Usernames are 3–20 characters: lowercase letters, numbers and underscores.';
  if (d.display_name.length > 40) return 'Display name can be up to 40 characters.';
  if (d.bio.length > 280) return 'Your bio can be up to 280 characters.';
  if (d.favorite_genres.length > MAX_GENRES) return `Pick up to ${MAX_GENRES} favorite genres.`;
  return '';
}

async function saveProfile(form) {
  const d = profileDraft;
  const fields = {
    display_name: d.display_name.trim() || null,
    username: d.username.trim().toLowerCase() || null,
    bio: d.bio.trim() || null,
    favorite_anime: d.favorite_anime.trim() || null,
    favorite_genres: d.favorite_genres,
  };
  const problem = validateProfile({ ...d, username: fields.username || '' });
  if (problem) { profileMessage(problem); return; }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    state.profile = await auth.updateProfile(fields);
    profileDraft = null;
    renderAccountButton();
    renderGreeting();
    renderProfile();
    toast('Profile saved ✓');
  } catch (e) {
    profileMessage(e.message);
    btn.disabled = false;
    btn.textContent = 'Save profile';
  }
}

// Crop to a centered square and resize to 256px so uploads stay small and fast.
function resizeImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        if (blob && blob.type === 'image/webp') return resolve(blob);
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not process that image.'))), 'image/jpeg', 0.88);
      }, 'image/webp', 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t a supported image.')); };
    img.src = url;
  });
}

async function changePhoto(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { profileMessage('Please choose a JPG, PNG or WebP image.'); return; }
  if (file.size > 15 * 1024 * 1024) { profileMessage('That image is too large. Please pick one under 15 MB.'); return; }
  const avatar = els.profileBody.querySelector('#profileAvatar');
  avatar?.classList.add('is-busy');
  profileMessage('');
  try {
    const blob = await resizeImage(file);
    const avatar_url = await auth.uploadAvatar(blob);
    state.profile = await auth.updateProfile({ avatar_url });
    renderAccountButton();
    renderProfile();
    toast('Profile photo updated ✓');
  } catch (e) {
    avatar?.classList.remove('is-busy');
    profileMessage(e.message);
  }
}

async function removePhoto() {
  try {
    await auth.removeAvatar();
    state.profile = await auth.updateProfile({ avatar_url: null });
    renderAccountButton();
    renderProfile();
    toast('Profile photo removed');
  } catch (e) {
    profileMessage(e.message);
  }
}

function initProfile() {
  els.profileBody.addEventListener('input', e => {
    const f = e.target;
    if (!profileDraft || !f.name || !(f.name in profileDraft)) return;
    if (f.name === 'username') {
      const clean = f.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (clean !== f.value) f.value = clean;
    }
    profileDraft[f.name] = f.value;
    if (f.name === 'bio') els.profileBody.querySelector('[data-bio-count]').textContent = f.value.length;
  });
  els.profileBody.addEventListener('change', e => {
    if (e.target.matches('[data-profile-photo]')) changePhoto(e.target);
  });
  els.profileBody.addEventListener('submit', e => {
    e.preventDefault();
    saveProfile(e.target);
  });
  els.profileBody.addEventListener('click', e => {
    const genre = e.target.closest('[data-genre]');
    if (genre && profileDraft) {
      const g = genre.dataset.genre;
      const list = profileDraft.favorite_genres;
      if (list.includes(g)) profileDraft.favorite_genres = list.filter(x => x !== g);
      else if (list.length >= MAX_GENRES) { profileMessage(`You can pick up to ${MAX_GENRES} genres.`); return; }
      else profileDraft.favorite_genres = [...list, g];
      genre.setAttribute('aria-pressed', String(profileDraft.favorite_genres.includes(g)));
      return;
    }
    const action = e.target.closest('[data-profile-action]')?.dataset.profileAction;
    if (action === 'reset') { profileDraft = null; renderProfile(); }
    else if (action === 'remove-photo') removePhoto();
  });
}

// ---------- Routing ----------
function route() {
  const view = (location.hash.replace('#', '') || 'news');
  state.view = ['news', 'seasonal', 'watchlist', 'profile'].includes(view) ? view : 'news';
  document.querySelectorAll('[data-view-panel]').forEach(p => { p.hidden = p.dataset.viewPanel !== state.view; });
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  if (state.view === 'seasonal') renderSeason();
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'news') renderNews();
  if (state.view === 'profile') renderProfile();
}

// ---------- Global events ----------
function initEvents() {
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-cat], [data-follow], [data-unfollow], [data-news-for], [data-action], [data-season]');
    if (!t) return;
    if (t.dataset.cat) {
      state.category = t.dataset.cat;
      renderNews();
      document.querySelector(`.chip[data-cat="${t.dataset.cat}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } else if (t.dataset.follow) toggleFollow(t.dataset.follow);
    else if (t.dataset.unfollow) toggleFollow(t.dataset.unfollow);
    else if (t.dataset.newsFor) {
      els.searchInput.value = t.dataset.newsFor;
      runSearch(t.dataset.newsFor);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (t.dataset.season) {
      state.seasonTab = t.dataset.season;
      renderSeason();
    } else if (t.dataset.action === 'refresh') loadFeed({ force: true });
    else if (t.dataset.action === 'season-retry') renderSeason();
    else if (t.dataset.action === 'signin') openAuth('signin');
    else if (t.dataset.action === 'profile-retry') loadProfile();
  });
  els.refreshBtn.addEventListener('click', () => { loadFeed({ force: true }); loadWeather(); });
  window.addEventListener('hashchange', route);

  // Auto-refresh; also refresh when returning to a stale tab.
  setInterval(() => { loadFeed({ force: true }); loadWeather(); renderGreeting(); }, REFRESH_MS);
  setInterval(() => { if (!state.loadingFeed) renderFeedStatus(document.querySelectorAll('#newsGrid .card:not(.skeleton)').length); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderGreeting();
    if (state.lastUpdated && Date.now() - state.lastUpdated.getTime() > REFRESH_MS) { loadFeed({ force: true }); loadWeather(); }
  });
}

// ---------- Boot ----------
initTheme();
initAccount();
initProfile();
renderGreeting();
initWeather();
initSearch();
initEvents();
renderWatchCount();
route();
loadWeather();
loadFeed();
