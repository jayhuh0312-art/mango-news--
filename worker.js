
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;
const MAX_ARTICLES = 15;
const FEED_TIMEOUT_MS = 5000;

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

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

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

function decodeXML(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 16));
      } catch {
        return "";
      }
    });
}

function getTag(item, tag) {
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    "<" + safeTag + "\\b[^>]*>([\\s\\S]*?)</" + safeTag + "\\s*>",
    "i"
  );

  const match = item.match(pattern);
  if (!match) return "";

  return decodeXML(
    match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, "")
      .trim()
  );
}

function getImageUrl(item) {
  const patterns = [
    /<media:content\b[^>]*>/i,
    /<media:thumbnail\b[^>]*>/i,
    /<enclosure\b[^>]*>/i
  ];

  for (const pattern of patterns) {
    const match = item.match(pattern);
    if (!match) continue;

    const urlMatch = match[0].match(/\burl\s*=\s*["']([^"']+)["']/i);

    if (urlMatch && /^https?:\/\//i.test(urlMatch[1])) {
      return decodeXML(urlMatch[1]);
    }
  }

  const imageMatch = item.match(
    /<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/i
  );

  return imageMatch ? decodeXML(imageMatch[1]) : "";
}

function parseRSS(xml, source) {
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) || [];

  return items.map(item => {
    const title = getTag(item, "title");

    return {
      title,
      originalTitle: title,
      description: getTag(item, "description").slice(0, 2000),
      url: getTag(item, "link"),
      domain: source,
      date: getTag(item, "pubDate"),
      image: getImageUrl(item)
    };
  }).filter(article => article.title && article.url);
}

async function fetchFeed(feed) {
  try {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": "MANGO-NEWS/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml"
      },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
    });

    if (!response.ok) {
      console.error("RSS 오류:", feed.name, response.status);
      return [];
    }

    return parseRSS(await response.text(), feed.name);
  } catch (error) {
    console.error("RSS 연결 오류:", feed.name, String(error));
    return [];
  }
}

function extractAIText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.output_text === "string") return result.output_text;

  if (Array.isArray(result?.choices)) {
    const choice = result.choices[0];
    const content = choice?.message?.content ?? choice?.text;

    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content.map(item => item?.text || "").join("\n");
    }
  }

  if (Array.isArray(result?.content)) {
    return result.content.map(item => item?.text || "").join("\n");
  }

  return "";
}

function parseJSON(raw) {
  const cleaned = String(raw || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first < 0 || last <= first) {
    throw new Error("AI가 올바른 JSON을 반환하지 않았어요.");
  }

  return JSON.parse(cleaned.slice(first, last + 1));
}

async function runAI(env, messages, maxTokens = 1800) {
  if (!env.AI) {
    throw new Error("Cloudflare AI 바인딩 AI를 찾을 수 없어요.");
  }

  const result = await env.AI.run(AI_MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.1
  });

  if (result?.success === false) {
    throw new Error("AI 요청이 실패했어요.");
  }

  const text = extractAIText(result);

  if (!text.trim()) {
    throw new Error("AI 응답이 비어 있어요.");
  }

  return text;
}

/*
 * 뉴스 목록은 AI 번역을 기다리지 않고 먼저 표시합니다.
 * 이 함수는 별도의 번역 API를 호출할 때만 사용합니다.
 */
async function simplifyNewsTitles(env, articles) {
  if (!env.AI || !articles.length) {
    return articles;
  }

  const input = articles.slice(0, MAX_ARTICLES).map((article, index) => ({
    id: index,
    title: article.originalTitle || article.title
  }));

  try {
    const raw = await runAI(env, [
      {
        role: "system",
        content: `
너는 어린이를 위한 한국어 뉴스 제목 편집자야.
입력된 모든 제목을 자연스럽고 쉬운 한국어로 바꿔.
외국어 제목은 한국어로 번역해.
인물, 장소, 숫자, 핵심 사실을 바꾸지 마.
반드시 JSON만 반환해.
{"titles":[{"id":0,"titleKo":"쉬운 한국어 제목"}]}
모든 입력에 대해 같은 id로 결과를 반환해.
`
      },
      {
        role: "user",
        content: JSON.stringify(input)
      }
    ], 1500);

    const data = parseJSON(raw);
    if (!Array.isArray(data.titles)) return articles;

    const titleMap = new Map();

    for (const item of data.titles) {
      if (
        Number.isInteger(item?.id) &&
        typeof item.titleKo === "string" &&
        item.titleKo.trim()
      ) {
        titleMap.set(item.id, item.titleKo.trim());
      }
    }

    return articles.map((article, index) => ({
      ...article,
      title: titleMap.get(index) || article.originalTitle || article.title
    }));
  } catch (error) {
    console.error("뉴스 제목 번역 실패:", String(error));
    return articles;
  }
}

function parseAIResponse(raw, originalTitle) {
  const data = parseJSON(raw);

  const article =
    typeof data.article === "string"
      ? data.article.trim()
      : typeof data.summary === "string"
        ? data.summary.trim()
        : "";

  if (!article || article.length < 20) {
    throw new Error("AI가 충분한 기사 설명을 만들지 못했어요.");
  }

  return {
    titleKo:
      typeof data.titleKo === "string" && data.titleKo.trim()
        ? data.titleKo.trim()
        : originalTitle,
    article,
    terms: Array.isArray(data.terms) ? data.terms : []
  };
}

async function summarizeArticle(env, article) {
  const raw = await runAI(env, [
    {
      role: "system",
      content: `
너는 어린이를 위한 한국어 뉴스 편집자야.
반드시 올바른 JSON만 반환해.
형식:
{
  "titleKo": "쉽고 자연스러운 한국어 제목",
  "article": "쉬운 한국어로 쓴 기사 설명",
  "terms": [
    {
      "term": "어려운 한국어 단어",
      "definition": "쉬운 한국어 뜻"
    }
  ]
}
초등학교 6학년이 이해할 수 있게 설명해.
최소 5개의 짧은 문장으로 핵심을 설명해.
원문에 없는 사실, 인물, 날짜, 숫자를 만들지 마.
본문에 실제 나오는 어려운 단어를 최대 5개 골라.
단어와 뜻은 자연스러운 한국어로 작성해.
JSON 바깥에는 다른 말을 쓰지 마.
`
    },
    {
      role: "user",
      content:
        "기사 제목:\n" + article.title +
        "\n\n기사 설명:\n" +
        (article.description || "추가 설명이 없습니다.")
    }
  ], 1800);

  const parsed = parseAIResponse(raw, article.title);

  const cleanText = value =>
    String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const terms = parsed.terms
    .filter(item =>
      item &&
      typeof item.term === "string" &&
      typeof item.definition === "string"
    )
    .map(item => ({
      term: cleanText(item.term),
      definition: cleanText(item.definition)
    }))
    .filter(item =>
      item.term &&
      item.definition &&
      /[가-힣]/.test(item.term) &&
      /[가-힣]/.test(item.definition)
    )
    .slice(0, 5);

  return {
    titleKo: cleanText(parsed.titleKo) || article.title,
    article: cleanText(parsed.article),
    terms
  };
}

async function searchArticleImage(title) {
  const query = String(title || "").trim().slice(0, 180);

  if (!query) {
    return { image: "", page: "" };
  }

  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url",
    iiurlwidth: "1000",
    format: "json",
    origin: "*"
  });

  try {
    const response = await fetch(
      "https://commons.wikimedia.org/w/api.php?" + params.toString(),
      {
        headers: {
          "User-Agent": "MANGO-NEWS/1.0 (educational news website)"
        },
        signal: AbortSignal.timeout(5000)
      }
    );

    if (!response.ok) {
      return { image: "", page: "" };
    }

    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {});

    const candidates = pages.filter(page => {
      const info = page.imageinfo?.[0];
      const image = info?.thumburl || info?.url || "";
      return /^https:\/\/upload\.wikimedia\.org\//i.test(image);
    });

    if (!candidates.length) {
      return { image: "", page: "" };
    }

    const info = candidates[0].imageinfo[0];

    return {
      image: info.thumburl || info.url || "",
      page: info.descriptionurl || ""
    };
  } catch (error) {
    console.error("이미지 검색 실패:", String(error));
    return { image: "", page: "" };
  }
}

async function getCachedNews() {
  try {
    const cache = caches.default;
    const cached = await cache.match(new Request(CACHE_KEY));

    if (!cached) return null;

    return await cached.json();
  } catch (error) {
    console.error("뉴스 캐시 읽기 실패:", String(error));
    return null;
  }
}

async function saveNewsCache(ctx, data) {
  try {
    const cache = caches.default;
    const request = new Request(CACHE_KEY);

    ctx.waitUntil(
      cache.put(
        request,
        new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=" + CACHE_SECONDS
          }
        })
      )
    );
  } catch (error) {
    console.error("뉴스 캐시 저장 실패:", String(error));
  }
}

async function getNews(ctx) {
  const cached = await getCachedNews();

  if (cached && Array.isArray(cached.articles) && cached.articles.length) {
    return jsonResponse(cached);
  }

  const feeds = await Promise.all(NEWS_FEEDS.map(fetchFeed));

  let articles = feeds.flat()
    .filter((article, index, all) =>
      all.findIndex(other => other.url === article.url) === index
    )
    .sort((a, b) =>
      (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
    )
    .slice(0, MAX_ARTICLES);

  if (!articles.length) {
    if (cached && Array.isArray(cached.articles) && cached.articles.length) {
      return jsonResponse(cached);
    }

    return jsonResponse({
      articles: [],
      count: 0,
      error: "뉴스 출처에 연결하지 못했어요. 잠시 후 다시 시도해 주세요."
    }, 502);
  }

  /*
   * 핵심 개선:
   * 뉴스 목록 요청에서는 AI 제목 번역을 기다리지 않습니다.
   * 따라서 AI가 느려도 뉴스 목록을 먼저 표시할 수 있습니다.
   */
  const data = {
    articles,
    count: articles.length,
    updatedAt: new Date().toISOString()
  };

  await saveNewsCache(ctx, data);

  return jsonResponse(data);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/news") {
      if (request.method !== "GET") {
        return jsonResponse({
          error: "GET 요청만 사용할 수 있어요."
        }, 405);
      }

      try {
        return await getNews(ctx);
      } catch (error) {
        console.error("뉴스 API 오류:", error);

        return jsonResponse({
          articles: [],
          error: "뉴스를 불러오지 못했어요. 잠시 후 다시 시도해 주세요."
        }, 500);
      }
    }

    if (url.pathname === "/api/summarize") {
      if (request.method !== "POST") {
        return jsonResponse({
          error: "POST 요청만 사용할 수 있어요."
        }, 405);
      }

      try {
        const body = await request.json();

        const title = String(
          body?.originalTitle || body?.title || ""
        ).trim().slice(0, 500);

        const description = String(
          body?.description || ""
        ).trim().slice(0, 3000);

        if (!title) {
          return jsonResponse({
            error: "기사 제목이 없어요."
          }, 400);
        }

        const result = await summarizeArticle(env, {
          title,
          description
        });

        return jsonResponse(result);
      } catch (error) {
        console.error("AI 요약 API 오류:", error?.stack || String(error));

        return jsonResponse({
          error: String(
            error?.message || "AI 설명을 만들지 못했어요."
          )
        }, 500);
      }
    }

    if (url.pathname === "/api/image-search") {
      if (request.method !== "GET") {
        return jsonResponse({
          error: "GET 요청만 사용할 수 있어요."
        }, 405);
      }

      const title = url.searchParams.get("title") || "";

      if (!title.trim()) {
        return jsonResponse({
          error: "기사 제목이 필요해요."
        }, 400);
      }

      return jsonResponse(await searchArticleImage(title));
    }

    if (url.pathname === "/api/generate-image") {
      return jsonResponse({
        error: "AI 그림 생성 기능은 사용하지 않아요."
      }, 410);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("ASSETS 바인딩을 찾을 수 없어요.", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
};
