
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;

const FEEDS = [
  {
    name: "연합뉴스",
    url: "https://www.yna.co.kr/rss/news.xml"
  },
  {
    name: "뉴시스",
    url: "https://www.newsis.com/RSS/sokbo.xml"
  },
  {
    name: "BBC News",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml"
  },
  {
    name: "Korea.net",
    url: "https://www.korea.net/koreanet/rss/news/2"
  }
];

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function getTag(xml, tag) {
  const match = xml.match(
    new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + "\\s*>", "i")
  );
  return match ? decodeXml(match[1]).trim() : "";
}

async function readFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      "User-Agent": "MANGO-NEWS/1.0",
      "Accept": "application/rss+xml, application/xml, text/xml"
    },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(feed.name + " returned " + response.status);
  }

  const xml = await response.text();
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  return items.map(item => {
    const title = getTag(item, "title");
    const link = getTag(item, "link");
    const description = getTag(item, "description");
    const date = getTag(item, "pubDate");

    return {
      title: title.replace(/<[^>]*>/g, "").trim(),
      description: description.replace(/<[^>]*>/g, " ").trim(),
      url: link,
      domain: feed.name,
      date
    };
  }).filter(article => article.title && /^https?:\/\//i.test(article.url));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/news") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405 }
        );
      }

      const cache = caches.default;
      const cacheRequest = new Request(CACHE_KEY);
      const cached = await cache.match(cacheRequest);

      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: cached.headers
        });
      }

      const results = await Promise.allSettled(
        FEEDS.map(readFeed)
      );

      const articles = results
        .filter(result => result.status === "fulfilled")
        .flatMap(result => result.value);

      const unique = [
        ...new Map(
          articles.map(article => [article.url, article])
        ).values()
      ]
        .sort((a, b) => {
          const da = Date.parse(a.date) || 0;
          const db = Date.parse(b.date) || 0;
          return db - da;
        })
        .slice(0, 40);

      if (unique.length === 0) {
        return Response.json(
          { error: "All news feeds are temporarily unavailable." },
          { status: 502 }
        );
      }

      const result = Response.json(
        { articles: unique },
        {
          headers: {
            "Cache-Control": "public, max-age=120"
          }
        }
      );

      ctx.waitUntil(cache.put(cacheRequest, result.clone()));
      return result;
    }

    return env.ASSETS.fetch(request);
  }
};
