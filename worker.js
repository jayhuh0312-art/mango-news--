export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/news') {
      const endpoint = 'https://api.gdeltproject.org/api/v2/doc/doc?query=(economy%20OR%20business%20OR%20technology%20OR%20science%20OR%20world)&mode=ArtList&format=json&sort=DateDesc&maxrecords=30';
      try {
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': 'MANGO-NEWS/1.0' }
        });
        if (!response.ok) {
          return Response.json({ error: 'News provider unavailable' }, { status: 502 });
        }
        const data = await response.json();
        const articles = (data.articles || []).map(a => ({
          title: a.title || '',
          description: a.seendate ? `보도 날짜: ${a.seendate}` : '',
          url: a.url || '',
          domain: a.domain || '',
          date: a.seendate || ''
        })).filter(a => a.title && a.url);
        return Response.json({ articles }, {
          headers: { 'Cache-Control': 'public, max-age=300' }
        });
      } catch {
        return Response.json({ error: 'Could not fetch news' }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
