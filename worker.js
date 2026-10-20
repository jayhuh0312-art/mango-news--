
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;

const FEEDS = [
  { name: "연합뉴스", url: "https://www.yna.co.kr/rss/news.xml" },
  { name: "뉴시스", url: "https://www.newsis.com/RSS/sokbo.xml" },
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "Korea.net", url: "https://www.korea.net/koreanet/rss/news/2" }
];

const ECONOMY_KEYWORDS = [
  "경제", "주식", "증시", "코스피", "코스닥",
  "나스닥", "다우", "주가", "상장", "실적",
  "매출", "영업이익", "순이익", "기업", "투자",
  "금리", "환율", "물가", "인플레이션", "수출",
  "수입", "무역", "고용", "실업", "부동산",
  "은행", "금융", "반도체", "배당", "채권",
  "시장", "관세", "중앙은행", "기준금리",
  "market", "stock", "stocks", "share price",
  "economy", "economic", "business", "finance",
  "inflation", "interest rate", "earnings",
  "revenue", "trade", "tariff", "nasdaq",
  "dow jones", "s&p 500", "ipo", "semiconductor",
  "wall street", "shares", "investor", "investors",
  "profit", "losses", "bond", "currency", "forex",
  "central bank", "gdp", "jobs report"
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
    new RegExp(
      "<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" +
      tag + "\\s*>",
      "i"
    )
  );

  return match ? decodeXml(match[1]).trim() : "";
}

function cleanText(text) {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 기사 원문에 포함된 이미지 주소 찾기
function extractImage(item) {
  const mediaTags =
    item.match(
      /<(?:media:content|media:thumbnail|media:group)\b[^>]*>/gi
    ) || [];

  for (const tag of mediaTags) {
    const urlMatch = tag.match(/\burl\s*=\s*(["'])(.*?)\1/i);
    const typeMatch = tag.match(/\btype\s*=\s*(["'])(.*?)\1/i);

    if (!urlMatch) continue;

    const imageUrl = decodeXml(urlMatch[2].trim());
    const mediaType = typeMatch?.[2]?.toLowerCase() || "";

    if (
      /^https?:\/\//i.test(imageUrl) &&
      (!mediaType || mediaType.startsWith("image/"))
    ) {
      return imageUrl;
    }
  }

  const enclosures =
    item.match(/<enclosure\b[^>]*>/gi) || [];

  for (const tag of enclosures) {
    const urlMatch = tag.match(/\burl\s*=\s*(["'])(.*?)\1/i);
    const typeMatch = tag.match(/\btype\s*=\s*(["'])(.*?)\1/i);

    if (!urlMatch) continue;

    const imageUrl = decodeXml(urlMatch[2].trim());
    const mediaType = typeMatch?.[2]?.toLowerCase() || "";

    if (
      /^https?:\/\//i.test(imageUrl) &&
      (
        mediaType.startsWith("image/") ||
        /\.(jpe?g|png|webp|gif|avif)(?:[?#].*)?$/i.test(imageUrl)
      )
    ) {
      return imageUrl;
    }
  }

  const htmlFields = [
    getTag(item, "description"),
    getTag(item, "content:encoded")
  ];

  for (const html of htmlFields) {
    const images = html.match(/<img\b[^>]*>/gi) || [];

    for (const img of images) {
      const srcMatch = img.match(
        /\b(?:src|data-src)\s*=\s*(["'])(.*?)\1/i
      );

      if (!srcMatch) continue;

      const imageUrl = decodeXml(srcMatch[2].trim());

      if (/^https?:\/\//i.test(imageUrl)) {
        return imageUrl;
      }
    }
  }

  return "";
}

function isEconomyNews(article) {
  const text =
    `${article.title} ${article.description}`.toLowerCase();

  return ECONOMY_KEYWORDS.some(keyword =>
    text.includes(keyword.toLowerCase())
  );
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
  const items =
    xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  return items.map(item => ({
    title: cleanText(getTag(item, "title")),
    description: cleanText(getTag(item, "description")),
    url: getTag(item, "link"),
    domain: feed.name,
    date: getTag(item, "pubDate"),
    image: extractImage(item)
  })).filter(article =>
    article.title &&
    /^https?:\/\//i.test(article.url)
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // AI 기사 이미지 생성
    if (url.pathname === "/api/generate-image") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "POST 요청만 사용할 수 있습니다." },
          { status: 405 }
        );
      }

      if (!env.AI) {
        return Response.json(
          { error: "Cloudflare AI 연결을 확인해 주세요." },
          { status: 500 }
        );
      }

      try {
        const body = await request.json();

        const title = typeof body.title === "string"
          ? body.title.trim().slice(0, 300)
          : "";

        const description =
          typeof body.description === "string"
            ? body.description.trim().slice(0, 1000)
            : "";

        if (!title) {
          return Response.json(
            { error: "뉴스 제목이 필요합니다." },
            { status: 400 }
          );
        }

        // 제목과 설명이 같은 기사는 같은 캐시 키를 사용해요.
        const keyText = title + "\n" + description;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(keyText)
        );

        const hash = Array.from(new Uint8Array(digest))
          .map(byte => byte.toString(16).padStart(2, "0"))
          .join("");

        const cache = caches.default;
        const imageCacheRequest = new Request(
          `https://mango-news-cache.internal/api/generated-image/${hash}`
        );

        const cachedImage = await cache.match(imageCacheRequest);

        if (cachedImage) {
          return new Response(cachedImage.body, {
            status: cachedImage.status,
            headers: cachedImage.headers
          });
        }

        // 뉴스 내용을 바탕으로 일러스트를 만들어요.
        const prompt =
          "Create a polished, friendly editorial illustration for a " +
          "Korean children's economics news website. " +
          "Create a visual metaphor that matches the news topic. " +
          "Use clear shapes, appealing colors, professional composition, " +
          "and a wide landscape layout suitable for a news article. " +
          "Do not include any text, letters, numbers, watermarks, logos, " +
          "captions, or fake newspaper headlines. " +
          "This is an illustration, not a documentary photograph. " +
          "News headline: " + title + ". " +
          "News context: " + (description || "No additional description.");

        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          {
            prompt: prompt.slice(0, 2048),
            steps: 4
          }
        );

        if (
          typeof result?.image !== "string" ||
          !result.image.trim()
        ) {
          throw new Error("이미지 모델이 그림을 반환하지 않았습니다.");
        }

        const imageResponse = Response.json(
          { image: "data:image/jpeg;base64," + result.image },
          {
            headers: {
              "Cache-Control": "public, max-age=86400"
            }
          }
        );

        // 생성한 그림을 Cloudflare 캐시에 보관해 재생성을 줄여요.
        ctx.waitUntil(
          cache.put(imageCacheRequest, imageResponse.clone())
        );

        return imageResponse;
      } catch (error) {
        console.error("AI image error:", error);

        return Response.json(
          {
            error:
              "AI 그림을 만들지 못했어요. 잠시 후 다시 시도해 주세요."
          },
          { status: 500 }
        );
      }
    }

    // AI 쉬운 뉴스 요약
    if (url.pathname === "/api/summarize") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "POST 요청만 사용할 수 있습니다." },
          { status: 405 }
        );
      }

      try {
        const body = await request.json();

        const title = typeof body.title === "string"
          ? body.title.trim().slice(0, 500)
          : "";

        const description =
          typeof body.description === "string"
            ? body.description.trim().slice(0, 4000)
            : "";

        const source = typeof body.source === "string"
          ? body.source.trim().slice(0, 100)
          : "";

        if (!title || !description) {
          return Response.json(
            { error: "뉴스 제목과 설명이 필요합니다." },
            { status: 400 }
          );
        }

        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fp8",
          {
            messages: [
              {
                role: "system",
                content:
                  "너는 MANGO NEWS의 어린이용 경제 뉴스 설명 도우미다. " +
                  "반드시 자연스러운 한국어로 초등학생도 이해하기 쉽게 작성한다. " +
                  "제공된 제목과 설명에 있는 사실만 사용한다. " +
                  "모르는 사실, 숫자, 원인, 결과를 지어내지 않는다. " +
                  "정보가 부족하면 부족하다고 솔직하게 밝힌다. " +
                  "투자를 권하거나 주식 매수·매도를 추천하지 않는다. " +
                  "짧고 읽기 쉬운 문장과 제목을 사용한다."
              },
              {
                role: "user",
                content:
                  "다음 뉴스의 제목과 설명만 참고해서 쉽게 풀어 줘.\n" +
                  "출처: " + (source || "알 수 없음") + "\n" +
                  "제목: " + title + "\n" +
                  "뉴스 설명: " + description + "\n\n" +
                  "아래 세 항목으로 작성해 줘.\n" +
                  "1. 무슨 일이야? (핵심 내용 2~3문장)\n" +
                  "2. 어려운 말 풀이 (있을 때만)\n" +
                  "3. 우리 생활과 무슨 관계가 있어? (자료에 근거해 설명하고, " +
                  "근거가 부족하면 단정하지 말 것)\n\n" +
                  "제공된 설명만으로 알 수 없는 내용은 추측하지 마."
              }
            ],
            max_tokens: 500
          }
        );

        const summary = result?.response;

        if (typeof summary !== "string" || !summary.trim()) {
          return Response.json(
            { error: "AI가 요약을 만들지 못했습니다. 다시 시도해 주세요." },
            { status: 502 }
          );
        }

        return Response.json(
          { summary: summary.trim() },
          {
            headers: {
              "Cache-Control": "no-store"
            }
          }
        );
      } catch (error) {
        console.error("AI summary error:", error);

        return Response.json(
          {
            error:
              "AI 요약 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요."
          },
          { status: 500 }
        );
      }
    }

    // 뉴스 수집
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
        .filter(isEconomyNews)
        .sort((a, b) => {
          const da = Date.parse(a.date) || 0;
          const db = Date.parse(b.date) || 0;
          return db - da;
        })
        .slice(0, 40);

      if (unique.length === 0) {
        return Response.json(
          {
            error:
              "경제·주식 뉴스가 없거나 뉴스 출처에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요."
          },
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
