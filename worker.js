
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

    // 뉴스 목록
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

    // AI 쉬운 뉴스
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
다음 경제 뉴스의 내용을 초등학생도 이해할 수 있는 쉬운 한국어 기사로 다시 써 줘.

[기사 작성 규칙]

1. 기사 본문은 기본적으로 6~8개의 완전한 문장으로 작성해.
2. 특별한 이유가 없다면 5문장 미만으로 끝내지 마.
3. 화면에서 줄바꿈이 어떻게 표시되는지와 관계없이 충분한 정보를 담아 줘.
4. "무슨 일이 있었나요?", "왜 중요할까요?" 같은 질문 형식의 소제목은 만들지 마. 자연스러운 기사 본문으로 작성해.
5. 가장 먼저 실제로 무슨 일이 일어났는지 설명해.
6. 제공된 정보가 뒷받침한다면 사건의 배경, 원인, 경제와 사람들에게 미치는 영향도 설명해.
7. 원문에 나온 국가, 인물, 날짜, 수치, 기업 이름과 핵심 사실은 정확하게 유지해.
8. 어려운 경제 표현은 초등학생도 이해할 수 있는 쉬운 말로 풀어서 설명해.
9. 같은 내용을 반복해서 분량만 늘리지 마.
10. 원문에 정보가 적다면 제목과 제공된 설명으로 확인할 수 있는 내용을 충분히 풀어서 설명하되, 원문에 없는 사실이나 수치, 인용문, 사건의 결과를 만들어 내지 마.
11. 경제적 영향이나 앞으로의 전망을 설명할 근거가 없다면 사실처럼 단정하지 마.
12. 기자 이름, 취재기자 표기, 기자 이메일, 연락처, 저작권 문구, 기사 작성자 소개는 본문에서 제외해.
13. 기자의 이름이 기사 내용에 섞여 있더라도 뉴스 이해에 필요하지 않은 기자 소개라면 제외해. 단, 사건의 핵심 당사자는 임의로 삭제하지 마.
14. 원문을 그대로 복사하지 말고, 핵심 사실을 유지하면서 쉬운 말로 다시 작성해.
15. 기사 본문에 "이 기사는", "기자에 따르면" 같은 불필요한 작성자 소개를 넣지 마.

[경제 용어 규칙]

- 기사 본문에 실제로 등장하는 경제 용어 중 알아둘 가치가 있는 용어를 최대 5개 골라.
- 각 용어의 뜻은 초등학생도 이해할 수 있도록 정확하고 쉽게 설명해.
- 기사 본문에 없는 단어를 경제 용어 목록에 추가하지 마.
- 설명할 경제 용어가 없다면 terms는 빈 배열로 해.

[출력 규칙]

반드시 아래 형식의 JSON 하나만 출력해.
마크다운 코드블록이나 JSON 앞뒤의 설명은 출력하지 마.

{
  "article": "쉬운 말로 다시 쓴 뉴스 본문",
  "terms": [
    {
      "term": "기사 본문에 등장하는 경제 용어",
      "definition": "초등학생도 이해할 수 있는 쉬운 설명"
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
                  "너는 사실을 정확하게 지키면서 경제 뉴스를 어린이용 쉬운 한국어 기사로 다시 쓰는 편집자야. 기사 본문은 충분히 자세하게 작성하고, 기자 소개나 이메일은 제외해. 요청된 JSON 형식을 정확하게 지켜."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            max_tokens: 1800
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

        let article = String(parsed.article || "").trim();

        // 기자 이메일과 작성자 표기 제거
        article = article
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
          .replace(/(?:사진|자료|취재|글)\s*=\s*[^。\n]+(?:기자)?/g, "")
          .replace(/[（(]\s*기자\s*[)）]/g, "")
          .replace(/\s{2,}/g, " ")
          .trim();

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

    // AI 그림 생성
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
