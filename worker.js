
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;

const NEWS_FEEDS = [
  {
    name: "연합뉴스",
    url: "https://www.yna.co.kr/rss/news.xml"
  },
  {
    name: "BBC News",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml"
  },
  {
    name: "Korea.net",
    url: "https://www.korea.net/RSS/News.xml"
  }
];

function decodeXML(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16))
    );
}

function getTag(item, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const cdataPattern = new RegExp(
    "<" + escapedTag + "\\b[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</" + escapedTag + "\\s*>",
    "i"
  );

  const normalPattern = new RegExp(
    "<" + escapedTag + "\\b[^>]*>([\\s\\S]*?)</" + escapedTag + "\\s*>",
    "i"
  );

  const cdataMatch = item.match(cdataPattern);
  if (cdataMatch) return decodeXML(cdataMatch[1].trim());

  const normalMatch = item.match(normalPattern);
  if (normalMatch) {
    return decodeXML(
      normalMatch[1].replace(/<[^>]*>/g, "").trim()
    );
  }

  return "";
}

function parseRSS(xml, source) {
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) || [];

  return items.map((item) => {
    const title = getTag(item, "title");
    const link = getTag(item, "link");
    const description = getTag(item, "description");
    const pubDate = getTag(item, "pubDate");

    return {
      title,
      description: description.slice(0, 1200),
      url: link,
      domain: source,
      date: pubDate
    };
  }).filter((article) => article.title && article.url);
}

async function fetchFeed(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": "MANGO-NEWS/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, */*"
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      return [];
    }

    const xml = await response.text();
    return parseRSS(xml, feed.name);
  } catch (error) {
    console.error("RSS feed failed:", feed.name, String(error));
    return [];
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/news") {
      const cache = caches.default;
      const cacheRequest = new Request(CACHE_KEY);

      if (request.method !== "GET") {
        return Response.json(
          { error: "GET requests only" },
          { status: 405 }
        );
      }

      const cached = await cache.match(cacheRequest);

      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-News-Cache": "HIT"
          }
        });
      }

      const results = await Promise.all(
        NEWS_FEEDS.map(fetchFeed)
      );

      const articles = results
        .flat()
        .filter((article, index, all) =>
          all.findIndex(
            (other) => other.url === article.url
          ) === index
        )
        .sort((a, b) => {
          const dateA = Date.parse(a.date) || 0;
          const dateB = Date.parse(b.date) || 0;
          return dateB - dateA;
        })
        .slice(0, 40);

      if (articles.length === 0) {
        return Response.json(
          {
            articles: [],
            error: "뉴스 RSS 피드에서 기사를 가져오지 못했어요.",
            updatedAt: new Date().toISOString()
          },
          {
            status: 502,
            headers: {
              "Cache-Control": "no-store; max-age=0"
            }
          }
        );
      }

      const data = {
        articles,
        updatedAt: new Date().toISOString(),
        count: articles.length
      };

      const response = Response.json(data, {
        headers: {
          "Cache-Control": "public, max-age=120",
          "X-News-Cache": "MISS"
        }
      });

      ctx.waitUntil(
        cache.put(
          cacheRequest,
          new Response(JSON.stringify(data), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=120"
            }
          })
        )
      );

      return response;
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "ASSETS 바인딩을 찾을 수 없어요. Cloudflare 설정을 확인해 주세요.",
      {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8"
        }
      }
    );
  }
};
