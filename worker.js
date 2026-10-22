
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

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

  return items.map((item) => ({
    title: getTag(item, "title"),
    description: getTag(item, "description").slice(0, 1200),
    url: getTag(item, "link"),
    domain: source,
    date: getTag(item, "pubDate")
  })).filter((article) => article.title && article.url);
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

    if (!response.ok) return [];

    return parseRSS(await response.text(), feed.name);
  } catch (error) {
    console.error("RSS feed failed:", feed.name, String(error));
    return [];
  }
}

async function readRequestBody(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("요청 내용을 읽지 못했어요. 다시 시도해 주세요.");
  }
}

function getArticleInput(body) {
  const title = String(body?.title || "").trim().slice(0, 500);
  const description = String(body?.description || "").trim().slice(0, 3000);

  if (!title) {
    throw new Error("기사 제목이 없어요.");
  }

  return { title, description };
}

async function summarizeArticle(env, article) {
  if (!env.AI) {
    throw new Error("Cloudflare Workers AI 바인딩 AI를 찾을 수 없어요.");
  }

  const result = await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        {
          role: "system",
          content: `너는 한국 초등학교 6학년도 이해할 수 있게 경제 뉴스를 설명하는 도우미야.
반드시 한국어로 답해.
기사에 없는 사실을 지어내지 마.
정확히 JSON 객체 하나만 출력해. 마크다운이나 코드블록은 사용하지 마.
형식:
{"article":"쉬운 설명","terms":[{"term":"용어","definition":"쉬운 뜻"}]}
article은 3~5개의 짧은 문장으로 설명해.
terms는 어려운 경제 용어 최대 3개야. 용어가 없으면 빈 배열을 사용해.`
        },
        {
          role: "user",
          content: `기사 제목: ${article.title}\n기사 설명: ${article.description || "제공된 설명 없음"}`
        }
      ],
      max_tokens: 700,
      temperature: 0.2
    }
  );

  let output = result?.response;

  if (typeof output !== "string" || !output.trim()) {
    throw new Error("AI가 비어 있는 답변을 보냈어요.");
  }

  output = output
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");

  if (first < 0 || last <= first) {
    throw new Error("AI 답변에서 JSON 형식을 찾지 못했어요.");
  }

  let parsed;

  try {
    parsed = JSON.parse(output.slice(first, last + 1));
  } catch {
    throw new Error("AI가 올바른 설명 형식을 만들지 못했어요. 다시 시도해 주세요.");
  }

  if (typeof parsed.article !== "string" || !parsed.article.trim()) {
    throw new Error("AI 설명 내용이 비어 있어요.");
  }

  const terms = Array.isArray(parsed.terms)
    ? parsed.terms
        .filter(item => item && typeof item.term === "string" &&
          typeof item.definition === "string")
        .slice(0, 3)
    : [];

  return {
    article: parsed.article,
    terms
  };
}

async function generateArticleImage(env, article) {
  if (!env.AI) {
    throw new Error("Cloudflare Workers AI 바인딩 AI를 찾을 수 없어요.");
  }

  const prompt = [
    "Create a clear editorial illustration for a Korean educational economics news website.",
    "Friendly, colorful, polished 2D illustration, simple composition, suitable for children.",
    "No text, no letters, no logos, no watermark.",
    "Illustrate this news topic:",
    article.title,
    article.description
  ].filter(Boolean).join("\n").slice(0, 1800);

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-1-schnell",
    {
      prompt,
      steps: 4
    }
  );

  if (!result || typeof result.image !== "string" || !result.image) {
    throw new Error("AI가 그림 데이터를 반환하지 않았어요.");
  }

  return { image: result.image };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 최신 뉴스
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

        const results = await Promise.all(NEWS_FEEDS.map(fetchFeed));

        const articles = results
          .flat()
          .filter((article, index, all) =>
            all.findIndex(other => other.url === article.url) === index
          )
          .sort((a, b) =>
            (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
          )
          .slice(0, 40);

        if (!articles.length) {
          return jsonResponse({
            articles: [],
            error: "뉴스 RSS 피드에서 기사를 가져오지 못했어요.",
            updatedAt: new Date().toISOString()
          }, 502);
        }

        const data = {
          articles,
          updatedAt: new Date().toISOString(),
          count: articles.length
        };

        ctx.waitUntil(
          cache.put(
            cacheRequest,
            new Response(JSON.stringify(data), {
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": `public, max-age=${CACHE_SECONDS}`
              }
            })
          )
        );

        return new Response(JSON.stringify(data), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-News-Cache": "MISS"
          }
        });
      } catch (error) {
        console.error("News API error:", String(error));

        return jsonResponse({
          articles: [],
          error: "뉴스를 불러오는 중 문제가 생겼어요.",
          details: String(error)
        }, 500);
      }
    }

    // 2. AI 쉬운 설명
    if (url.pathname === "/api/summarize") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST 요청만 사용할 수 있어요." }, 405);
      }

      try {
        const body = await readRequestBody(request);
        const article = getArticleInput(body);
        const result = await summarizeArticle(env, article);

        return jsonResponse(result);
      } catch (error) {
        console.error("Summarize API error:", String(error));

        return jsonResponse({
          error: String(error?.message || "AI 요약에 실패했어요.")
        }, 500);
      }
    }

    // 3. AI 기사 그림
    if (url.pathname === "/api/generate-image") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "POST 요청만 사용할 수 있어요." }, 405);
      }

      try {
        const body = await readRequestBody(request);
        const article = getArticleInput(body);
        const result = await generateArticleImage(env, article);

        return jsonResponse(result);
      } catch (error) {
        console.error("Image API error:", String(error));

        return jsonResponse({
          error: String(error?.message || "AI 그림 생성에 실패했어요.")
        }, 500);
      }
    }

    // 4. 웹사이트 파일 제공
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
