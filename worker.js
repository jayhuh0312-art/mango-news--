
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

function decodeXML(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
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
    return decodeXML(normalMatch[1].replace(/<[^>]*>/g, "").trim());
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

    // RSS에 이미지가 들어 있는 경우에만 이미지 주소를 추출합니다.
    const image =
      getTag(item, "media:content") ||
      getTag(item, "media:thumbnail") ||
      getTag(item, "enclosure");

    const imageUrl = (() => {
      const urlMatch = image.match(/url=["']([^"']+)["']/i);
      if (urlMatch) return urlMatch[1];

      if (/^https?:\/\//i.test(image)) return image;
      return "";
    })();

    return {
      title,
      description: description.slice(0, 1200),
      url: link,
      domain: source,
      date: pubDate,
      image: imageUrl
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
      console.error("RSS HTTP error:", feed.name, response.status);
      return [];
    }

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

  if (!title) throw new Error("기사 제목이 없어요.");

  return { title, description };
}

function extractAIText(result) {
  // 일반적인 Workers AI 텍스트 모델 응답
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.output_text === "string") return result.output_text;

  // 일부 모델은 다른 응답 구조를 반환할 수 있습니다.
  if (Array.isArray(result?.choices)) {
    const choice = result.choices[0];
    const content = choice?.message?.content ?? choice?.text;

    if (typeof content === "string") return content;
  }

  if (Array.isArray(result?.content)) {
    return result.content
      .map(item => typeof item?.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function summarizeArticle(env, article) {
  if (!env.AI) {
    throw new Error("Cloudflare Workers AI 바인딩 AI를 찾을 수 없어요.");
  }

  // 먼저 비교적 가벼운 텍스트 모델을 사용합니다.
  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        {
          role: "system",
          content: `너는 한국 초등학교 6학년도 이해할 수 있게 경제 뉴스를 설명하는 도우미야.
반드시 한국어로 답해.
기사에 없는 사실을 지어내지 마.
반드시 아래 JSON 형식으로만 답해. 마크다운이나 코드블록은 쓰지 마.
{"article":"쉬운 설명","terms":[{"term":"경제 용어","definition":"쉬운 뜻"}]}
article에는 기사의 핵심을 3~5개의 짧은 문장으로 설명해.
terms에는 어려운 용어를 최대 3개 넣어. 없으면 빈 배열 []을 사용해.`
        },
        {
          role: "user",
          content: `기사 제목: ${article.title}\n기사 설명: ${article.description || "추가 설명 없음"}`
        }
      ],
      max_tokens: 700,
      temperature: 0.2
    }
  );

  const output = extractAIText(result).trim();

  if (!output) {
    // 실제 응답 구조를 확인할 수 있도록 서버 로그에 남깁니다.
    console.error("AI returned no text:", JSON.stringify(result).slice(0, 3000));

    if (result?.success === false && Array.isArray(result?.errors)) {
      const details = result.errors
        .map(item => item.message || item.code || "")
        .filter(Boolean)
        .join("; ");

      throw new Error(
        details
          ? `Cloudflare AI 오류: ${details}`
          : "Cloudflare AI가 요청을 처리하지 못했어요. Cloudflare 로그를 확인해 주세요."
      );
    }

    throw new Error(
      "AI 응답에 설명 문장이 없어요. Cloudflare 대시보드의 Worker 로그를 확인해 주세요."
    );
  }

  const cleaned = output
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first < 0 || last <= first) {
    console.error("AI returned non-JSON text:", cleaned.slice(0, 2000));

    // JSON을 만들지 못한 경우에도 실제 문장이 있다면 설명으로 보여 줍니다.
    return {
      article: cleaned.slice(0, 4000),
      terms: []
    };
  }

  let parsed;

  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1));
  } catch (error) {
    console.error("AI JSON parse error:", String(error));
    console.error("AI output:", cleaned.slice(0, 2000));

    throw new Error("AI 답변의 형식이 올바르지 않아요. 다시 시도해 주세요.");
  }

  if (typeof parsed.article !== "string" || !parsed.article.trim()) {
    throw new Error("AI 답변에 쉬운 설명이 들어 있지 않아요.");
  }

  const terms = Array.isArray(parsed.terms)
    ? parsed.terms
        .filter(item =>
          item &&
          typeof item.term === "string" &&
          typeof item.definition === "string"
        )
        .slice(0, 3)
    : [];

  return {
    article: parsed.article.trim(),
    terms
  };
}

async function generateArticleImage(env, article) {
  if (!env.AI) {
    throw new Error("Cloudflare Workers AI 바인딩 AI를 찾을 수 없어요.");
  }

  const prompt = [
    "Create a colorful, friendly editorial illustration for a Korean educational economics news website.",
    "Polished 2D cartoon illustration, simple composition, suitable for children and teenagers.",
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
    console.error("AI image response was empty:", JSON.stringify(result).slice(0, 1000));
    throw new Error("AI가 그림 데이터를 반환하지 않았어요.");
  }

  return { image: result.image };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 최신 뉴스 API
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

    // AI 쉬운 설명 API
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
        console.error("Summarize API error:", error?.stack || String(error));

        return jsonResponse({
          error: String(error?.message || "AI 요약에 실패했어요.")
        }, 500);
      }
    }

    // AI 기사 그림 API
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
        console.error("Image API error:", error?.stack || String(error));

        return jsonResponse({
          error: String(error?.message || "AI 그림 생성에 실패했어요.")
        }, 500);
      }
    }

    // 웹사이트 파일 제공
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
