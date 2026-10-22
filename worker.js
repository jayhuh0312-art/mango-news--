
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;

const NEWS_FEEDS = [
  { name: "연합뉴스", url: "https://www.yna.co.kr/rss/news.xml" },
  { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { name: "Korea.net", url: "https://www.korea.net/RSS/News.xml" }
];

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
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; }
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

  return items.map(item => ({
    title: getTag(item, "title"),
    description: getTag(item, "description").slice(0, 2000),
    url: getTag(item, "link"),
    domain: source,
    date: getTag(item, "pubDate"),
    image: getImageUrl(item)
  })).filter(article => article.title && article.url);
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

function parseAIResponse(raw) {
  const cleaned = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  // JSON 앞뒤에 불필요한 문장이 있어도 JSON 부분을 찾아봅니다.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));

      if (typeof parsed.article === "string" && parsed.article.trim()) {
        return {
          titleKo: String(parsed.titleKo || "").trim(),
          article: parsed.article.trim(),
          terms: Array.isArray(parsed.terms) ? parsed.terms : []
        };
      }
    } catch (error) {
      console.warn("AI JSON 해석 실패:", String(error));
    }
  }

  // JSON이 아니어도 일반 텍스트 설명이 있으면 사용합니다.
  const plainText = cleaned
    .replace(/^(쉬운 설명|설명|요약)\s*[:：]\s*/i, "")
    .trim();

  if (plainText.length >= 20) {
    return {
      titleKo: "",
      article: plainText,
      terms: []
    };
  }

  throw new Error("AI 답변을 읽을 수 없어요. 다시 시도해 주세요.");
}

async function summarizeArticle(env, article) {
  if (!env.AI) {
    throw new Error(
      "Cloudflare AI 바인딩 AI를 찾을 수 없어요. Cloudflare 설정을 확인해 주세요."
    );
  }

  const result = await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        {
          role: "system",
          content: `너는 세계의 뉴스를 한국어로 번역하고 쉽게 설명하는 도우미야.

반드시 한국어로 답해.
입력 언어가 영어, 일본어, 중국어 또는 다른 언어여도 한국어로 번역해.
기사 제목도 자연스러운 한국어로 번역해.
기사에 없는 사실을 지어내지 마.
제공된 제목과 설명에 근거해서 작성해.

반드시 다음 JSON 형식으로만 답해.
마크다운이나 코드블록은 쓰지 마.

{
  "titleKo": "한국어 기사 제목",
  "article": "쉬운 한국어 설명",
  "terms": [
    {
      "term": "본문에 등장하는 어려운 단어",
      "definition": "초등학교 6학년도 이해할 수 있는 쉬운 뜻"
    }
  ]
}

작성 규칙:
1. titleKo는 원래 기사 제목을 한국어로 번역한 제목이야.
2. article은 최소 7개의 짧은 한국어 문장으로 작성해.
3. 각 문장은 줄바꿈으로 구분해.
4. 초등학교 6학년도 이해할 수 있는 표현을 사용해.
5. 어려운 경제·사회 용어는 쉬운 말로 설명해.
6. 기사에 없는 수치, 인물, 원인, 결과를 만들어 내지 마.
7. terms에는 본문에 실제로 등장하는 어려운 단어를 최대 5개 넣어.
8. term은 article에 실제로 등장하는 단어와 똑같이 써.
9. definition은 한국어로 쉽게 작성해.
10. 어려운 단어가 없으면 terms는 []로 작성해.
11. JSON 바깥에는 아무것도 쓰지 마.`
        },
        {
          role: "user",
          content:
            "기사 제목:\n" + article.title +
            "\n\n기사 설명:\n" +
            (article.description || "추가 설명이 없습니다.")
        }
      ],
      max_tokens: 1800,
      temperature: 0.1
    }
  );

  if (result?.success === false) {
    console.error("Workers AI 실행 실패:", JSON.stringify(result));
    throw new Error(
      "Cloudflare AI 요청이 실패했어요. Worker 로그와 AI 사용량을 확인해 주세요."
    );
  }

  const raw = extractAIText(result);

  if (!raw.trim()) {
    console.error("AI 응답이 비어 있음:", JSON.stringify(result));
    throw new Error(
      "AI 응답이 비어 있어요. Cloudflare Worker 로그를 확인해 주세요."
    );
  }

  const parsed = parseAIResponse(raw);

  const terms = parsed.terms
    .filter(item =>
      item &&
      typeof item.term === "string" &&
      typeof item.definition === "string" &&
      item.term.trim() &&
      item.definition.trim()
    )
    .slice(0, 5);

  return {
    titleKo: parsed.titleKo || article.title,
    article: parsed.article,
    terms
  };
}

async function searchArticleImage(title) {
  const query = String(title || "").trim().slice(0, 180);
  if (!query) return { image: "", page: "" };

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
      console.error("이미지 검색 오류:", response.status);
      return { image: "", page: "" };
    }

    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {});

    const candidates = pages.filter(page => {
      const info = page.imageinfo?.[0];
      const image = info?.thumburl || info?.url || "";

      return image &&
        /^https:\/\/upload\.wikimedia\.org\//i.test(image) &&
        /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(image);
    });

    if (!candidates.length) return { image: "", page: "" };

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

    if (url.pathname === "/api/news") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "GET 요청만 사용할 수 있어요." }, 405);
      }

      try {
        const cache = caches.default;
        const cacheRequest = new Request(CACHE_KEY);
        const cached = await cache.match(cacheRequest);

        if (cached) {
          const data = await cached.json();

          return new Response(JSON.stringify(data), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "X-News-Cache": "HIT"
            }
          });
        }

        const feeds = await Promise.all(NEWS_FEEDS.map(fetchFeed));

        const articles = feeds
          .flat()
          .filter((article, index, all) =>
            all.findIndex(other => other.url === article.url) === index
          )
          .sort((a, b) =>
            (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
          )
          .slice(0, 40);

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

    if (url.pathname === "/api/image-search") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "GET 요청만 사용할 수 있어요." }, 405);
      }

      const title = url.searchParams.get("title") || "";

      if (!title.trim()) {
        return jsonResponse({ error: "기사 제목이 필요해요." }, 400);
      }

      return jsonResponse(await searchArticleImage(title));
    }

    if (url.pathname === "/api/summarize") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST 요청만 사용할 수 있어요." }, 405);
      }

      try {
        const body = await request.json();
        const title = String(body?.title || "").trim().slice(0, 500);
        const description = String(body?.description || "").trim().slice(0, 3000);

        if (!title) {
          return jsonResponse({ error: "기사 제목이 없어요." }, 400);
        }

        const result = await summarizeArticle(env, {
          title,
          description
        });

        return jsonResponse(result);
      } catch (error) {
        console.error("AI 요약 API 오류:", error?.stack || String(error));

        return jsonResponse({
          error: String(error?.message || "AI 설명을 만들지 못했어요.")
        }, 500);
      }
    }

    // AI 그림 생성은 사용하지 않습니다.
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
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
