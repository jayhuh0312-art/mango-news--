
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
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)); }
      catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 16)); }
      catch { return ""; }
    });
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

function getImageUrl(item) {
  // media:content, media:thumbnail, enclosure는
  // 이미지 URL이 태그의 url 속성에 들어가는 경우가 많습니다.
  const tags = [
    /<media:content\b[^>]*>/i,
    /<media:thumbnail\b[^>]*>/i,
    /<enclosure\b[^>]*>/i
  ];

  for (const pattern of tags) {
    const match = item.match(pattern);
    if (!match) continue;

    const urlMatch = match[0].match(/\burl\s*=\s*["']([^"']+)["']/i);
    if (urlMatch && /^https?:\/\//i.test(urlMatch[1])) {
      return decodeXML(urlMatch[1]);
    }
  }

  // 본문 안에 <img src="...">가 있는 RSS도 확인합니다.
  const htmlImage = item.match(
    /<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/i
  );

  if (htmlImage) return decodeXML(htmlImage[1]);

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
      date: pubDate,
      image: getImageUrl(item)
    };
  }).filter(article => article.title && article.url);
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
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.output_text === "string") return result.output_text;

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

  const result = await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    {
      messages: [
        {
          role: "system",
          content: `너는 한국 초등학교 6학년도 이해할 수 있게 뉴스를 설명하는 도우미야.
반드시 한국어로 답해.
기사 제목과 설명에 있는 정보만 사용하고, 기사에 없는 사실을 지어내지 마.
반드시 JSON 형식으로만 답해. 마크다운이나 코드블록은 쓰지 마.

출력 형식:
{"article":"쉬운 설명","terms":[{"term":"어려운 단어","definition":"쉬운 뜻"}]}

규칙:
1. article은 핵심 내용을 최소 7개의 짧은 문장으로 설명해.
2. 각 문장은 줄바꿈으로 구분해. 한 문장에 너무 많은 내용을 넣지 마.
3. 초등학교 6학년이 이해할 수 있는 쉬운 표현을 사용해.
4. 원인과 결과, 관련된 사람이나 기관, 경제에 미치는 영향을 기사에 나온 범위에서 설명해.
5. 정보가 부족한 부분은 추측하지 마.
6. terms에는 본문에 실제로 등장하는 어려운 단어를 최대 5개 넣어.
7. term은 article 안에 실제로 적힌 단어와 똑같이 써야 해. 그래야 본문에서 형광펜으로 강조할 수 있어.
8. definition은 해당 단어의 뜻을 초등학교 6학년도 이해할 수 있게 설명해.
9. 적합한 어려운 단어가 없으면 terms는 빈 배열 []로 만들어.
10. JSON 바깥에는 다른 문장을 쓰지 마.`
        },
        {
          role: "user",
          content: `기사 제목: ${article.title}\n기사 설명: ${article.description || "추가 설명 없음"}`
        }
      ],
      max_tokens: 1200,
      temperature: 0.2
    }
  );

  const output = extractAIText(result).trim();

  if (!output) {
    console.error("AI returned no text:", JSON.stringify(result).slice(0, 3000));

    if (result?.success === false && Array.isArray(result?.errors)) {
      const details = result.errors
        .map(item => item.message || item.code || "")
        .filter(Boolean)
        .join("; ");

      throw new Error(details
        ? `Cloudflare AI 오류: ${details}`
        : "Cloudflare AI가 답변하지 않았어요. Worker 로그를 확인해 주세요.");
    }

    throw new Error("AI가 설명을 반환하지 않았어요.");
  }

  const cleaned = output
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first < 0 || last <= first) {
    console.error("AI returned non-JSON text:", cleaned.slice(0, 2000));
    throw new Error("AI 답변 형식이 올바르지 않아요. 다시 시도해 주세요.");
  }

  let parsed;

  try {
    parsed = JSON.parse(cleaned.slice(first, last + 1));
  } catch (error) {
    console.error("AI JSON parse error:", String(error));
    throw new Error("AI 답변을 읽지 못했어요. 다시 시도해 주세요.");
  }

  if (typeof parsed.article !== "string" || !parsed.article.trim()) {
    throw new Error("AI 답변에 쉬운 설명이 들어 있지 않아요.");
  }

  const terms = Array.isArray(parsed.terms)
    ? parsed.terms
        .filter(item =>
          item &&
          typeof item.term === "string" &&
          typeof item.definition === "string" &&
          item.term.trim() &&
          item.definition.trim()
        )
        .slice(0, 5)
    : [];

  return {
    article: parsed.article.trim(),
    terms
  };
}

// RSS에 사진이 없을 때 실제 공개 이미지 파일을 검색합니다.
// 이 기능은 AI 그림을 생성하지 않습니다.
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
      console.error("Wikimedia image search error:", response.status);
      return { image: "", page: "" };
    }

    const data = await response.json();
    const pages = Object.values(data?.query?.pages || {});

    const candidates = pages
      .filter(page => {
        const imageInfo = page.imageinfo?.[0];
        const imageUrl = imageInfo?.thumburl || imageInfo?.url || "";

        return imageUrl &&
          /^https:\/\/upload\.wikimedia\.org\//i.test(imageUrl) &&
          /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(imageUrl);
      })
      .map(page => ({
        image: page.imageinfo[0].thumburl || page.imageinfo[0].url,
        page: page.imageinfo[0].descriptionurl || page.canonicalurl || ""
      }));

    return candidates[0] || { image: "", page: "" };
  } catch (error) {
    console.error("Wikimedia image search failed:", String(error));
    return { image: "", page: "" };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 뉴스 목록 API
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

    // 기사 제목으로 실제 이미지 검색
    if (url.pathname === "/api/image-search") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "GET 요청만 사용할 수 있어요." }, 405);
      }

      const title = url.searchParams.get("title") || "";

      if (!title.trim()) {
        return jsonResponse({ error: "기사 제목이 필요해요." }, 400);
      }

      const result = await searchArticleImage(title);

      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=3600"
        }
      });
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
          error: String(error?.message || "AI 설명을 만들지 못했어요.")
        }, 500);
      }
    }

    // AI 그림 생성 API는 더 이상 사용하지 않습니다.
    if (url.pathname === "/api/generate-image") {
      return jsonResponse({
        error: "AI 그림 생성 기능은 사용하지 않아요. 실제 뉴스 이미지를 검색해 주세요."
      }, 410);
    }

    // 웹사이트 파일 제공
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "ASSETS 바인딩을 찾을 수 없어요. Cloudflare 설정을 확인해 주세요.",
      {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      }
    );
  }
};
