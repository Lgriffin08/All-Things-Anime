import {
  fetchAnnNews, fetchAnimeNews, fetchSeason, searchAnime,
  fetchWeather, geocode, DEFAULT_LOCATION, safeUrl,
} from './api.js';

const USER_NAME = 'Latrell';
const REFRESH_MS = 10 * 60 * 1000;     // auto-refresh feed + weather every 10 minutes
const DAY_MS = 24 * 60 * 60 * 1000;
const FEATURED_SHOWS = 6;              // how many top airing shows to pull MAL news for

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
  watchNewsCache: new Map(),
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
};

// ---------- Utilities ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } }
function read(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function loadWatchlist() { const w = read('ata.watchlist', []); return Array.isArray(w) ? w : []; }
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
      if (match) out.image = match.image;
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
  els.greeting.textContent = h >= 23 || h < 5 ? `${en}, ${USER_NAME}? Night-owl mode on.` : `${en}, ${USER_NAME}!`;
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
      els.newsGrid.innerHTML = emptyState('🔍', `No news found for “${state.query}”`, 'Try another title, or a different spelling (English or Japanese).');
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

  let ann = [];
  let mal = [];
  const errors = [];

  // ANN and the seasonal list load in parallel; MAL per-show news follows once we know the top shows.
  const annP = fetchAnnNews({ force }).then(items => {
    ann = items;
    state.feed = dedupeSort(enrich([...ann, ...mal]));
    state.loadingFeed = true;
    renderNews();
  }).catch(e => errors.push(e));

  const malP = (async () => {
    try {
      const { list, season } = await fetchSeason('now', { force: false });
      state.seasonNow = { list, season };
      indexAnime(list);
      const top = [...list].sort((a, b) => b.members - a.members).slice(0, FEATURED_SHOWS);
      const results = await Promise.allSettled(top.map(a => fetchAnimeNews(a, { force })));
      for (const r of results) if (r.status === 'fulfilled') mal.push(...r.value);
    } catch (e) { errors.push(e); }
  })();

  await Promise.all([annP, malP]);

  state.feed = dedupeSort(enrich([...ann, ...mal]));
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
    // Pull dedicated news for the best two matches.
    const results = await Promise.allSettled(found.slice(0, 2).map(a => fetchAnimeNews(a)));
    if (token !== searchToken) return;
    const extra = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    // Also include any ANN stories that mention the matched titles.
    const annHits = state.feed.filter(it => found.slice(0, 2).some(a => matchesAnime(it, a)));
    state.searchNews = enrich([...extra, ...annHits]);
    renderNews();
  } catch {
    if (token !== searchToken) return;
    els.searchAnime.innerHTML = '<span class="anime-strip__label">Anime lookup is unavailable right now, so these results come from the latest headlines only.</span>';
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

// ---------- Watchlist ----------
const isFollowing = id => state.watchlist.some(w => w.id === id);

function followButton(a, small = false) {
  const on = isFollowing(a.id);
  return `<button type="button" class="btn ${on ? 'btn--ghost is-following' : 'btn--ghost'} ${small ? 'btn--sm' : 'btn--sm'}" data-follow="${a.id}" aria-pressed="${on}">
    ${on ? '★ Following' : '☆ Follow'}</button>`;
}

function toggleFollow(id) {
  id = Number(id);
  if (isFollowing(id)) {
    const a = state.watchlist.find(w => w.id === id);
    state.watchlist = state.watchlist.filter(w => w.id !== id);
    toast(`Removed ${a?.title || 'show'} from your watchlist`);
  } else {
    const a = state.animeIndex.get(id);
    if (!a) return;
    state.watchlist.push({ id: a.id, title: a.title, image: a.image, titles: a.titles });
    toast(`Following ${a.title} ★`);
  }
  store('ata.watchlist', state.watchlist);
  updateFollowButtons();
  renderWatchCount();
  if (state.view === 'watchlist') renderWatchlist();
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

let watchToken = 0;
async function renderWatchlist() {
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

  const token = ++watchToken;
  const fromFeed = state.feed.filter(it => list.some(a => matchesAnime(it, a)));
  const cached = list.flatMap(a => state.watchNewsCache.get(a.id) || []);
  const show = items => {
    const all = dedupeSort(enrich([...fromFeed, ...items]));
    els.watchGrid.innerHTML = all.length ? all.map(newsCard).join('')
      : emptyState('🕊️', 'No news for your shows yet', 'We check Anime News Network and MyAnimeList, so new stories will show up here as they come out.');
  };
  const missing = list.filter(a => !state.watchNewsCache.has(a.id));
  if (missing.length && !cached.length && !fromFeed.length) els.watchGrid.innerHTML = skeletons(3);
  else show(cached);

  if (!missing.length) return;
  await Promise.allSettled(missing.map(async a => {
    const items = await fetchAnimeNews(a);
    state.watchNewsCache.set(a.id, items);
  }));
  if (token !== watchToken) return;
  show(list.flatMap(a => state.watchNewsCache.get(a.id) || []));
}

// ---------- Seasonal ----------
function seasonLabel(s) {
  if (!s) return '';
  return `${s.season[0].toUpperCase()}${s.season.slice(1)} ${s.year}`;
}

function animeCard(a, upcoming) {
  const meta = upcoming
    ? [a.type, a.airedFrom ? `Premieres ${new Date(a.airedFrom).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : (a.season ? seasonLabel(a) : 'TBA')]
    : [a.type, a.episodes ? `${a.episodes} eps` : null, a.broadcast];
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
    : 'Coming Next';
  const sorted = [...list].sort((a, b) => b.members - a.members);
  els.seasonGrid.innerHTML = sorted.length ? sorted.map(a => animeCard(a, tab === 'upcoming')).join('')
    : emptyState('🌸', 'No shows listed yet', 'Check back soon.');
}

// ---------- Routing ----------
function route() {
  const view = (location.hash.replace('#', '') || 'news');
  state.view = ['news', 'seasonal', 'watchlist'].includes(view) ? view : 'news';
  document.querySelectorAll('[data-view-panel]').forEach(p => { p.hidden = p.dataset.viewPanel !== state.view; });
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  if (state.view === 'seasonal') renderSeason();
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'news') renderNews();
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
renderGreeting();
initWeather();
initSearch();
initEvents();
renderWatchCount();
route();
loadWeather();
loadFeed();
