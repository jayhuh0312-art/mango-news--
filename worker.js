
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;

const NEWS_FEEDS = [
  { name: "연합뉴스", url: "https://www.yna.co.kr/rss/news.xml" },
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Korea.net", url: "https://www.korea.net/RSS/News.xml" }
];

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
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
  const items =
    xml.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) || [];

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
      signal: AbortSignal.timeout(10000)
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
    throw new Error(
      "Cloudflare AI 바인딩 AI를 찾을 수 없어요. 설정을 확인해 주세요."
    );
  }

  const result = await env.AI.run(AI_MODEL, {
    messages,
    max_tokens: maxTokens,
    temperature: 0.1
  });

  if (result?.success === false) {
    console.error("Workers AI 오류:", JSON.stringify(result));
    throw new Error("AI 요청이 실패했어요.");
  }

  const text = extractAIText(result);

  if (!text.trim()) {
    console.error("AI 응답이 비어 있음:", JSON.stringify(result));
    throw new Error("AI 응답이 비어 있어요.");
  }

  return text;
}

/*
 * 뉴스 제목을 한 번의 AI 요청으로 한국어 번역하고 쉽게 바꿉니다.
 * 원래 제목은 originalTitle에 보관합니다.
 */
async function simplifyNewsTitles(env, articles) {
  if (!env.AI || !articles.length) {
    return articles;
  }

  const input = articles.map((article, index) => ({
    id: index,
    title: article.originalTitle || article.title
  }));

  try {
    const raw = await runAI(env, [
      {
        role: "system",
        content: `
너는 어린이를 위한 한국어 뉴스 제목 편집자야.

입력된 모든 뉴스 제목을 자연스러운 한국어로 번역하고 쉽게 바꿔.
이미 한국어인 제목도 어려운 표현을 쉬운 말로 바꿔.
영어, 일본어, 중국어 등 외국어 제목은 반드시 한국어로 번역해.
한자만 있는 제목도 의미를 한국어로 풀어서 써.
핵심 사실과 인물, 장소, 숫자를 바꾸거나 만들어 내지 마.
제목을 너무 길게 만들지 말고 핵심을 간단히 전달해.
뉴스의 의미를 추측해서 바꾸지 마.
원문이 불명확하면 의미를 과장하지 않는 번역을 선택해.

반드시 다음 형식의 JSON만 반환해.
{"titles":[{"id":0,"titleKo":"쉽고 자연스러운 한국어 제목"}]}

모든 입력 제목에 대해 결과를 하나씩 반환해.
id는 입력과 동일하게 유지해.
JSON 바깥에는 다른 말을 쓰지 마.
`
      },
      {
        role: "user",
        content: JSON.stringify(input)
      }
    ], 2500);

    const data = parseJSON(raw);

    if (!Array.isArray(data.titles)) {
      throw new Error("AI 제목 목록이 올바르지 않아요.");
    }

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

    // AI가 실패해도 뉴스 목록 자체는 표시합니다.
    return articles;
  }
}

/*
 * AI의 제목·본문·단어 설명을 읽습니다.
 * 비정상 JSON이면 기사 설명을 억지로 JSON으로 표시하지 않습니다.
 */
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

다음 형식을 지켜:
{
  "titleKo": "쉽고 자연스러운 한국어 제목",
  "article": "첫 번째 문장. 두 번째 문장. 세 번째 문장.",
  "terms": [
    {
      "term": "본문에 실제로 나오는 어려운 한국어 단어",
      "definition": "그 단어를 쉽게 풀어 쓴 한국어 뜻"
    }
  ]
}

제목 규칙:
- 영어, 일본어, 중국어 등 외국어 제목은 한국어로 번역해.
- 한국어 제목도 어린이가 이해하기 쉬운 표현으로 바꿔.
- 어려운 한자어나 전문 용어는 쉬운 한국어로 풀어 써.
- 원문에 없는 사실을 추가하지 마.

본문 규칙:
- 초등학교 6학년이 이해할 수 있는 쉬운 한국어로 써.
- 최소 7개의 짧은 문장으로 설명해.
- 같은 내용을 반복해 문장 수를 채우지 마.
- 원문에 없는 인물, 날짜, 숫자, 사건을 만들어 내지 마.
- 기사 설명에 정보가 부족하면 확인 가능한 사실만 설명해.
- 외국어 기사는 핵심 내용을 한국어로 번역해서 설명해.
- JSON 문자열 안에 실제 줄바꿈을 넣지 마.

단어 규칙:
- 본문에 실제 등장하는 어려운 단어만 최대 5개 골라.
- terms의 단어와 뜻은 모두 한국어로 작성해.
- 最高처럼 중국어·일본어 한자 표현을 그대로 단어 목록에 넣지 마.
- 한자어는 가능하면 쉬운 한국어 표현으로 바꿔.
- 고유명사는 억지로 단어 목록에 넣지 마.
- 뜻풀이에 불필요한 외국어 또는 한자만으로 된 표현을 사용하지 마.
- 어려운 단어가 없으면 terms는 []로 작성해.
- JSON 바깥에 다른 설명을 쓰지 마.
`
    },
    {
      role: "user",
      content:
        "기사 제목:\n" + article.title +
        "\n\n기사 설명:\n" +
        (article.description || "추가 설명이 없습니다.")
    }
  ]);

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
        signal: AbortSignal.timeout(8000)
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /*
     * 뉴스 목록
     * 원래 제목은 originalTitle에 보관하고,
     * title에는 AI가 쉽게 바꾼 제목을 넣습니다.
     */
    if (url.pathname === "/api/news") {
      if (request.method !== "GET") {
        return jsonResponse(
          { error: "GET 요청만 사용할 수 있어요." },
          405
        );
      }

      try {
        const cache = caches.default;
        const cacheRequest = new Request(CACHE_KEY);
        const cached = await cache.match(cacheRequest);

        if (cached) {
          const data = await cached.json();

          return jsonResponse(data);
        }

        const feeds = await Promise.all(NEWS_FEEDS.map(fetchFeed));

        let articles = feeds.flat()
          .filter((article, index, all) =>
            all.findIndex(other => other.url === article.url) === index
          )
          .sort((a, b) =>
            (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
          )
          .slice(0, 40);

        // 뉴스 제목을 AI로 번역하고 쉽게 바꿉니다.
        articles = await simplifyNewsTitles(env, articles);

        const data = {
          articles,
          count: articles.length,
          updatedAt: new Date().toISOString()
        };

        if (articles.length) {
          ctx.waitUntil(
            cache.put(
              cacheRequest,
              new Response(JSON.stringify(data), {
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "public, max-age=" + CACHE_SECONDS
                }
              })
            )
          );
        }

        return jsonResponse(data, articles.length ? 200 : 502);
      } catch (error) {
        console.error("뉴스 API 오류:", error);

        return jsonResponse({
          articles: [],
          error: "뉴스를 불러오지 못했어요."
        }, 500);
      }
    }

    /*
     * AI 쉬운 설명
     */
    if (url.pathname === "/api/summarize") {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "POST 요청만 사용할 수 있어요." },
          405
        );
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
          return jsonResponse(
            { error: "기사 제목이 없어요." },
            400
          );
        }

        const result = await summarizeArticle(env, {
          title,
          description
        });

        return jsonResponse(result);
      } catch (error) {
        console.error(
          "AI 요약 API 오류:",
          error?.stack || String(error)
        );

        return jsonResponse({
          error: String(
            error?.message || "AI 설명을 만들지 못했어요."
          )
        }, 500);
      }
    }

    /*
     * 기사 관련 이미지 검색
     */
    if (url.pathname === "/api/image-search") {
      if (request.method !== "GET") {
        return jsonResponse(
          { error: "GET 요청만 사용할 수 있어요." },
          405
        );
      }

      const title = url.searchParams.get("title") || "";

      if (!title.trim()) {
        return jsonResponse(
          { error: "기사 제목이 필요해요." },
          400
        );
      }

      return jsonResponse(await searchArticleImage(title));
    }

    /*
     * AI 그림 생성은 사용하지 않습니다.
     */
    if (url.pathname === "/api/generate-image") {
      return jsonResponse({
        error: "AI 그림 생성 기능은 사용하지 않아요."
      }, 410);
    }

    /*
     * 그 외 요청은 Cloudflare Assets로 전달합니다.
     */
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
