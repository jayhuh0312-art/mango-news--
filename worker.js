
const CACHE_SECONDS = 120;

const RSS_FEEDS = [
  { name: "연합뉴스", url: "https://www.yna.co.kr/rss/news.xml" },
  { name: "뉴시스", url: "https://www.newsis.com/RSS/sokbo.xml" },
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { name: "Korea.net", url: "https://www.korea.net/koreanet/rss/news/2" }
];

const ECONOMY_KEYWORDS = [
  "경제", "금융", "주식", "증시", "코스피", "코스닥", "환율", "금리",
  "물가", "부동산", "기업 실적", "기업 투자", "수출", "수입", "무역",
  "은행", "투자", "고용", "취업", "일자리", "소비자물가", "인플레이션",
  "반도체", "배터리", "원화", "달러", "유가", "재정", "세금", "예산",
  "경제정책", "비트코인", "가상자산", "국채", "채권", "기준금리",
  "중앙은행", "연준", "한국은행", "GDP", "business", "economy",
  "economic", "stock market", "finance", "financial", "inflation",
  "trade", "investment", "employment", "interest rate", "bond yield",
  "gross domestic product", "consumer prices"
];

const EXCLUDE_KEYWORDS = [
  "축구", "야구", "농구", "배구", "골프 경기", "올림픽 경기", "연예인",
  "아이돌", "신곡", "앨범 발매", "드라마 출연", "영화 개봉", "시사회",
  "살인 사건", "교통사고", "실종", "화재 사고", "날씨 예보"
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

      if (cached) return cached;

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

        ctx.waitUntil(cache.put(NEWS_CACHE_KEY, response.clone()));

        return response;
      } catch (error) {
        console.error("News collection error:", error);

        return jsonResponse({
          error: "뉴스를 불러오지 못했어요.",
          details: String(error?.message || error),
          articles: []
        }, 502);
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
        return jsonResponse({
          error: "Cloudflare AI 바인딩을 찾을 수 없어요.",
          help: "Cloudflare 대시보드에서 이 Worker에 AI 바인딩을 추가한 뒤 다시 배포해 주세요."
        }, 500);
      }

      try {
        const body = await request.json();
        const title = String(body.title || "").slice(0, 500);
        const description = String(body.description || "").slice(0, 5000);

        if (!title && !description) {
          return jsonResponse(
            { error: "다시 쓸 기사 내용이 없어요." },
            400
          );
        }

        const prompt = `
다음 뉴스의 내용을 초등학생도 이해할 수 있는 쉬운 한국어 기사로 다시 써 줘.

중요한 규칙:
- "무슨 일이 있었나요?", "왜 중요할까요?" 같은 별도 질문 항목은 만들지 마.
- 원래 기사의 핵심 사실, 인물, 국가, 날짜, 숫자와 인과관계는 유지해.
- 원문에 없는 사실을 추측하거나 덧붙이지 마.
- 문장은 짧고 자연스럽게 써.
- 어려운 표현은 쉬운 말로 바꿔.
- 원문에 정보가 적으면 억지로 내용을 늘리지 마.
- 기사 본문은 실제 뉴스 내용을 짧고 쉽게 다시 쓴 글이어야 해.
- 경제 용어 중 알아둘 가치가 있는 용어는 최대 5개 골라.
- 각 용어는 기사 본문에도 실제로 등장하는 표현을 사용해.
- 용어 설명은 초등학생도 이해할 수 있도록 정확하고 짧게 써.
- 경제 용어가 없다면 terms는 빈 배열로 해.
- 반드시 JSON 하나만 출력해. 마크다운 코드블록은 사용하지 마.

출력 형식:
{
  "article": "쉽게 다시 쓴 기사 본문",
  "terms": [
    {
      "term": "기사에 등장한 경제 용어",
      "definition": "쉬운 설명"
    }
  ]
}

기사 제목:
${title}

기사 원문 또는 제공된 설명:
${description}
`;

        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fp8",
          {
            messages: [
              {
                role: "system",
                content:
                  "너는 사실을 지키며 경제 뉴스를 어린이용 쉬운 한국어로 다시 쓰는 편집자야. 요청된 JSON 형식을 정확히 지켜."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            max_tokens: 1200
          }
        );

        const raw =
          result?.response ||
          result?.result?.response ||
          "";

        if (!raw) {
          return jsonResponse(
            { error: "AI가 쉬운 기사를 만들지 못했어요." },
            502
          );
        }

        let parsed;

        try {
          const cleaned = raw
            .replace(/^```(?:json)?\s*/i, "")
            .replace(/\s*```$/, "")
            .trim();

          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");

          parsed = JSON.parse(
            start >= 0 && end > start
              ? cleaned.slice(start, end + 1)
              : cleaned
          );
        } catch {
          parsed = {
            article: raw.trim(),
            terms: []
          };
        }

        const article = String(parsed.article || "").trim();

        const terms = Array.isArray(parsed.terms)
          ? parsed.terms
              .filter(
                item =>
                  item &&
                  typeof item.term === "string" &&
                  typeof item.definition === "string"
              )
              .slice(0, 5)
              .map(item => ({
                term: item.term.trim().slice(0, 80),
                definition: item.definition.trim().slice(0, 400)
              }))
          : [];

        if (!article) {
          return jsonResponse(
            { error: "AI가 쉬운 기사 내용을 반환하지 않았어요." },
            502
          );
        }

        return jsonResponse({ article, terms });
      } catch (error) {
        console.error("AI summary error:", error);

        return jsonResponse({
          error: "AI 쉬운 뉴스 생성 중 문제가 생겼어요.",
          details: String(error?.message || error).slice(0, 1000)
        }, 500);
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
        return jsonResponse({
          error: "Cloudflare AI 바인딩을 찾을 수 없어요.",
          help: "Cloudflare 대시보드에서 이 Worker에 AI 바인딩을 추가한 뒤 다시 배포해 주세요."
        }, 500);
      }

      try {
        const body = await request.json();
        const title = String(body.title || "").slice(0, 250);
        const description = String(body.description || "").slice(0, 600);

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
          .map(byte => byte.toString(16).padStart(2, "0"))
          .join("");

        const imageCacheRequest = new Request(
          `https://mango-news-cache.internal/api/generated-image/${hash}`
        );

        const cachedImage = await cache.match(imageCacheRequest);

        if (cachedImage) return cachedImage;

        const prompt = `
Create a friendly landscape editorial illustration for a children's
educational Korean economy news website.
Use warm mango-yellow accents and a modern magazine illustration style.
Clearly depict the main subject of the news.
Use simple visual storytelling.
Do not include text, letters, numbers, watermarks, or logos.

News topic: ${title}
Context: ${description}
`.trim().slice(0, 1800);

        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-1-schnell",
          {
            prompt,
            steps: 4
          }
        );

        if (
          !result ||
          typeof result.image !== "string" ||
          !result.image.length
        ) {
          console.error("AI image response did not contain an image.");

          return jsonResponse(
            { error: "AI 응답에 그림 데이터가 없어요." },
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
        console.error("MANGO NEWS image generation error:", error);

        return jsonResponse({
          error: "AI 그림 생성에 실패했어요.",
          details: String(error?.message || error).slice(0, 1000)
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  }
};

async function collectNews() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(async feed => {
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "MANGO-NEWS/1.0",
          "Accept": "application/rss+xml, application/xml, text/xml"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!response.ok) {
        throw new Error(
          `${feed.name} 응답 오류: ${response.status}`
        );
      }

      return parseFeed(await response.text(), feed.name);
    })
  );

  const allArticles = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      allArticles.push(...result.value);
    } else {
      console.error("RSS feed error:", result.reason);
    }
  }

  if (!allArticles.length) {
    throw new Error("사용할 수 있는 뉴스 RSS가 없어요.");
  }

  const seen = new Set();

  const uniqueArticles = allArticles.filter(article => {
    const key = article.link || article.title;

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  const economyArticles = uniqueArticles.filter(article => {
    const text = `${article.title} ${article.description}`.toLowerCase();

    const matchesEconomy = ECONOMY_KEYWORDS.some(
      keyword => text.includes(keyword.toLowerCase())
    );

    const matchesClearlyUnrelated = EXCLUDE_KEYWORDS.some(
      keyword => text.includes(keyword.toLowerCase())
    );

    return matchesEconomy && !matchesClearlyUnrelated;
  });

  return economyArticles
    .sort(
      (a, b) =>
        new Date(b.pubDate || 0) - new Date(a.pubDate || 0)
    )
    .slice(0, 40);
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  return blocks.map(block => {
    const title = cleanText(getTag(block, "title"));

    const description = cleanText(
      getTag(block, "description") ||
      getTag(block, "summary") ||
      getTag(block, "content:encoded") ||
      getTag(block, "content")
    );

    let link = getTag(block, "link");

    if (!link) {
      const match = block.match(
        /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i
      );

      link = match ? match[1] : "";
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
  }).filter(article => article.title && article.link);
}

function getTag(xml, tagName, attributeName = null) {
  const escapedTag = tagName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

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
