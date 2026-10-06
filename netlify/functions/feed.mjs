// Server-side RSS fetcher. Browsers can't read these feeds directly (no CORS headers),
// so the app calls /api/feed?src=ann or /api/feed?src=mal and this function relays the XML.
const FEEDS = {
  ann: 'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',
  mal: 'https://myanimelist.net/rss/news.xml',
};

export default async (req) => {
  const src = new URL(req.url).searchParams.get('src');
  const target = FEEDS[src];
  if (!target) return new Response('Unknown feed', { status: 400 });

  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(9000),
    });
    const body = await res.text();
    if (!res.ok || !body.includes('<rss')) {
      return new Response(`Upstream ${res.status}`, { status: 502 });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        // Cache at Netlify's edge for 5 minutes so we don't hit the sources on every visit.
        'Cache-Control': 'public, max-age=120',
        'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(`Fetch failed: ${e.message}`, { status: 502 });
  }
};

export const config = { path: '/api/feed' };
