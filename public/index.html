
const CACHE_SECONDS = 120;

const RSS_FEEDS = [
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
    url: "https://feeds.bbci.co.uk/news/business/rss.xml"
  },
  {
    name: "Korea.net",
    url: "https://www.korea.net/koreanet/rss/news/2"
  }
];

const ECONOMY_KEYWORDS = [
  "경제", "금융", "주식", "증시", "코스피", "코스닥",
  "환율", "금리", "물가", "부동산", "기업", "산업",
  "수출", "수입", "무역", "은행", "투자", "고용",
  "취업", "일자리", "소비", "시장", "성장", "무역",
  "경제성장", "실업", "인플레이션", "반도체", "배터리",
  "원화", "달러", "유가", "재정", "세금", "예산",
  "경제정책", "비트코인", "가상자산", "GDP", "경제협력",
  "business", "economy", "economic", "stock", "market",
  "finance", "financial", "inflation", "trade", "bank",
  "interest rate", "investment", "employment"
];

const NEWS_CACHE_KEY = new Request(
  "https://mango-news-cache.internal/api/news"
);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/news") {
      if (request.method !== "GET") {
        return jsonResponse(
          { error: "GET 요청만 사용할 수 있어요." },
          405
        );
      }

      const cache = caches.default;
      const cached = await cache.match(NEWS_CACHE_KEY);

      if (cached) {
        return cached;
      }

      try {
        const articles = await collectNews();

        const response = jsonResponse(
          {
            articles,
            updatedAt: new Date().toISOString()
          },
          200,
          { "Cache-Control": `public, max-age=${CACHE_SECONDS}` }
        );

        ctx.waitUntil(
          cache.put(NEWS_CACHE_KEY, response.clone())
        );

        return response;
      } catch (error) {
        return jsonResponse(
          {
            error: "뉴스를 불러오지 못했어요.",
            details: String(error),
            articles: []
          },
          502
        );
      }
    }

    if (url.pathname === "/api/summarize") {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "POST 요청만 사용할 수 있어요." },
          405
        );
      }

      if (!env.AI) {
        return jsonResponse(
          { error: "Cloudflare AI 바인딩을 찾을 수 없어요." },
          500
        );
      }

      try {
        const body = await request.json();
        const title = String(body.title || "").slice(0, 500);
        const description = String(body.description || "").slice(0, 5000);

        if (!title && !description) {
          return jsonResponse(
            { error: "요약할 기사 내용이 없어요." },
            400
          );
        }

        const prompt = `
너는 초등학생도 이해할 수 있게 경제 뉴스를 설명하는 한국어 선생님이야.

아래 뉴스 정보를 바탕으로 기사를 쉽게 설명해 줘.

[기사 제목]
${title}

[기사 설명]
${description}

작성 규칙:
1. 어려운 경제 용어는 쉬운 말로 풀어 줘.
2. 기사에 없는 사실을 지어내지 마.
3. 제목만 보고 알 수 없는 내용을 확정해서 말하지 마.
4. 핵심 내용을 2~4개의 짧은 문단으로 설명해 줘.
5. 마지막에 "왜 중요할까요?"라는 소제목과 함께 의미를 설명해 줘.
6. 기사 내용이 부족하면 부족하다고 알려 줘.
7. 한국어로 답해 줘.
`;

        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fp8",
          {
            messages: [
              {
                role: "system",
                content:
                  "너는 정확하고 친절한 경제 뉴스 설명 도우미야. 근거 없는 내용을 만들어내지 마."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            max_tokens: 700
          }
        );

        const summary =
          result?.response ||
          result?.result?.response ||
          "";

        if (!summary) {
          return jsonResponse(
            { error: "AI가 요약을 만들지 못했어요." },
            502
          );
        }

        return jsonResponse({ summary });
      } catch (error) {
        return jsonResponse(
          {
            error: "AI 요약 중 문제가 생겼어요.",
            details: String(error)
          },
          500
        );
      }
    }

    if (url.pathname === "/api/generate-image") {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "POST 요청만 사용할 수 있어요." },
          405
        );
      }

      if (!env.AI) {
        return jsonResponse(
          { error: "Cloudflare AI 바인딩을 찾을 수 없어요." },
          500
        );
      }

      try {
        const body = await request.json();
        const title = String(body.title || "").slice(0, 300);
        const description = String(body.description || "").slice(0, 1500);

        if (!title && !description) {
          return jsonResponse(
            { error: "그림을 만들 기사 정보가 없어요." },
            400
          );
        }

        const cache = caches.default;
        const cacheText = `${title}\n${description}`;
        const hashBuffer = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(cacheText)
        );

        const hash = Array.from(new Uint8Array(hashBuffer))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");

        const imageCacheRequest = new Request(
          `https://mango-news-cache.internal/api/generated-image/${hash}`
        );

        const cachedImage = await cache.match(imageCacheRequest);

        if (cachedImage) {
          return cachedImage;
        }

        const prompt = `
Create a polished editorial illustration for a Korean educational
economy news website called MANGO NEWS.

The illustration should visually represent the following news.
News title: ${title}
News description: ${description}

Visual requirements:
- Clear, friendly, modern editorial illustration.
- Appropriate for students and general readers.
- Show the main idea using recognizable objects and visual metaphors.
- Warm mango-yellow accents with a clean, balanced composition.
- Professional news illustration, not a photograph.
- No written words, letters, numbers, captions, watermarks, or logos.
- Do not depict a specific real person unless necessary.
- No misleading charts, statistics, or invented readable text.
- Landscape composition, 16:9 aspect ratio.
`;

        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          {
            prompt,
            steps: 4
          }
        );

        if (!result || !result.image) {
          return jsonResponse(
            { error: "AI가 그림을 만들지 못했어요." },
            502
          );
        }

        const imageResponse = jsonResponse(
          {
            image: `data:image/jpeg;base64,${result.image}`
          },
          200,
          { "Cache-Control": "public, max-age=86400" }
        );

        ctx.waitUntil(
          cache.put(imageCacheRequest, imageResponse.clone())
        );

        return imageResponse;
      } catch (error) {
        return jsonResponse(
          {
            error: "AI 그림 생성 중 문제가 생겼어요.",
            details: String(error)
          },
          500
        );
      }
    }

    // 나머지 요청은 public 폴더의 파일로 처리해요.
    return env.ASSETS.fetch(request);
  }
};

async function collectNews() {
  const feedResults = await Promise.allSettled(
    RSS_FEEDS.map(async (feed) => {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "MANGO-NEWS/1.0",
          "Accept": "application/rss+xml, application/xml, text/xml"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        throw new Error(`${feed.name} 응답 오류: ${response.status}`);
      }

      const xml = await response.text();
      return parseFeed(xml, feed.name);
    })
  );

  const allArticles = [];

  for (const result of feedResults) {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
    }
  }

  if (allArticles.length === 0) {
    throw new Error("사용할 수 있는 뉴스 RSS가 없어요.");
  }

  const seen = new Set();

  const uniqueArticles = allArticles.filter((article) => {
    const key = article.link || article.title;

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });

  const economyArticles = uniqueArticles.filter((article) => {
    const text = `${article.title} ${article.description}`.toLowerCase();

    return ECONOMY_KEYWORDS.some((keyword) =>
      text.includes(keyword.toLowerCase())
    );
  });

  const articles = (economyArticles.length > 0
    ? economyArticles
    : uniqueArticles
  )
    .sort((a, b) => {
      return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
    })
    .slice(0, 40);

  return articles;
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  return blocks.map((block) => {
    const title = cleanText(
      getTag(block, "title")
    );

    const description = cleanText(
      getTag(block, "description") ||
      getTag(block, "summary") ||
      getTag(block, "content:encoded") ||
      getTag(block, "content")
    );

    let link = getTag(block, "link");

    // Atom 형식의 link href도 지원해요.
    if (!link) {
      const linkMatch = block.match(
        /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i
      );
      link = linkMatch ? linkMatch[1] : "";
    }

    const pubDate =
      getTag(block, "pubDate") ||
      getTag(block, "published") ||
      getTag(block, "updated") ||
      getTag(block, "dc:date");

    const image =
      getTag(block, "media:content", "url") ||
      getTag(block, "media:thumbnail", "url") ||
      getTag(block, "enclosure", "url") ||
      findImage(description);

    return {
      title,
      description: description.slice(0, 4000),
      link: decodeEntities(link).trim(),
      pubDate: cleanText(pubDate),
      image: image || "",
      source
    };
  }).filter((article) => article.title && article.link);
}

function getTag(xml, tagName, attributeName = null) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (attributeName) {
    const regex = new RegExp(
      `<${escapedTag}\\b[^>]*\\b${attributeName}=["']([^"']+)["'][^>]*>`,
      "i"
    );
    const match = xml.match(regex);
    return match ? decodeEntities(match[1]) : "";
  }

  const regex = new RegExp(
    `<${escapedTag}\\b[^>]*>([\\s\\S]*?)<\\/${escapedTag}\\s*>`,
    "i"
  );

  const match = xml.match(regex);
  return match ? match[1] : "";
}

function findImage(text) {
  const match = text.match(
    /<img\b[^>]*\bsrc=["']([^"']+)["']/i
  );

  return match ? decodeEntities(match[1]) : "";
}

function cleanText(value) {
  return decodeEntities(String(value || ""))
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, number) =>
      String.fromCodePoint(Number(number))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, number) =>
      String.fromCodePoint(parseInt(number, 16))
    );
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}
