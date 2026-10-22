
const CACHE_KEY = "https://mango-news-cache.internal/api/news";
const CACHE_SECONDS = 120;
const MAX_ARTICLES = 100;
const FEED_TIMEOUT_MS = 7000;
const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const NEWS_FEEDS = [
  {
    name: "연합뉴스",
    region: "국내",
    url: "https://www.yna.co.kr/rss/news.xml"
  },
  {
    name: "Korea.net",
    region: "국내",
    url: "https://www.korea.net/RSS/News.xml"
  },
  {
    name: "BBC News",
    region: "해외",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml"
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

function decodeXML(text = "") {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
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
    })
    .replace(/<[^>]*>/g, "")
    .trim();
}

function getTag(item, tag) {
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const pattern = new RegExp(
    "<" + safeTag + "\\b[^>]*>([\\s\\S]*?)</" +
    safeTag + "\\s*>",
    "i"
  );

  const match = item.match(pattern);
  return match ? decodeXML(match[1]) : "";
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

    const urlMatch = match[0].match(
      /\burl\s*=\s*["']([^"']+)["']/i
    );

    if (urlMatch && /^https?:\/\//i.test(urlMatch[1])) {
      return decodeXML(urlMatch[1]);
    }
  }

  const imageMatch = item.match(
    /<img\b[^>]*\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/i
  );

  return imageMatch ? decodeXML(imageMatch[1]) : "";
}

function getCategory(article) {
  const text = (
    (article.originalTitle || article.title || "") +
    " " +
    (article.description || "")
  ).toLowerCase();

  if (/주식|증시|코스피|코스닥|상장|주가|배당|나스닥|stock market|shares|stocks/.test(text)) {
    return "주식";
  }

  if (/경제|금리|물가|환율|은행|금융|수출|수입|무역|부동산|고용|실업|inflation|interest rate|economy|business/.test(text)) {
    return "경제";
  }

  if (/대통령|국회|국회의원|정당|선거|정부|장관|정치|법안|president|election|parliament|politics/.test(text)) {
    return "정치";
  }

  if (/인공지능|\bai\b|반도체|로봇|스마트폰|컴퓨터|인터넷|우주|과학|기술|소프트웨어|technology|artificial intelligence|science/.test(text)) {
    return "기술";
  }

  if (/사건|사고|경찰|법원|학교|학생|교육|병원|건강|환경|화재|교통|범죄|시민|지역|school|court|health|environment/.test(text)) {
    return "사회";
  }

  if (/미국|중국|일본|북한|유럽|러시아|우크라이나|중동|전쟁|국제|세계|해외|international|world|united states|china|japan|europe/.test(text)) {
    return "국제";
  }

  return "일반";
}

function parseRSS(xml, feed) {
  const items = xml.match(
    /<item\b[^>]*>[\s\S]*?<\/item\s*>/gi
  ) || [];

  return items.map(item => {
    const title = getTag(item, "title");

    return {
      title,
      originalTitle: title,
      description: getTag(item, "description").slice(0, 2000),
      url: getTag(item, "link"),
      domain: feed.name,
      date: getTag(item, "pubDate"),
      image: getImageUrl(item),
      region: feed.region
    };
  }).filter(article =>
    article.title &&
    /^https?:\/\//i.test(article.url)
  );
}

async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    FEED_TIMEOUT_MS
  );

  try {
    const response = await fetch(feed.url, {
      headers: {
        "Accept": "application/rss+xml, application/xml, text/xml"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      console.error("RSS 오류:", feed.name, response.status);
      return [];
    }

    return parseRSS(await response.text(), feed);
  } catch (error) {
    console.error("RSS 연결 오류:", feed.name, String(error));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function getCachedNews() {
  try {
    const cached = await caches.default.match(
      new Request(CACHE_KEY)
    );

    if (!cached) return null;

    const data = await cached.json();

    return Array.isArray(data.articles) ? data : null;
  } catch (error) {
    console.error("캐시 읽기 오류:", String(error));
    return null;
  }
}

async function saveNewsCache(ctx, data) {
  try {
    const response = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=" + CACHE_SECONDS
      }
    });

    ctx.waitUntil(
      caches.default.put(
        new Request(CACHE_KEY),
        response
      )
    );
  } catch (error) {
    console.error("캐시 저장 오류:", String(error));
  }
}

async function getNews(ctx, forceRefresh = false) {
  const cached = await getCachedNews();

  if (!forceRefresh && cached && cached.articles.length) {
    return jsonResponse(cached);
  }

  const feedResults = await Promise.all(
    NEWS_FEEDS.map(fetchFeed)
  );

  const unique = new Map();

  for (const article of feedResults.flat()) {
    if (!unique.has(article.url)) {
      unique.set(article.url, {
        ...article,
        category: getCategory(article)
      });
    }
  }

  const allArticles = Array.from(unique.values()).sort(
    (a, b) =>
      (Date.parse(b.date) || 0) -
      (Date.parse(a.date) || 0)
  );

  const domestic = allArticles.filter(
    article => article.region === "국내"
  );

  const international = allArticles.filter(
    article => article.region === "해외"
  );

  // 국내와 해외 뉴스를 번갈아 배치합니다.
  // 한쪽 뉴스가 부족하면 다른 쪽 뉴스로 채웁니다.
  const mixed = [];
  const maxLength = Math.max(
    domestic.length,
    international.length
  );

  for (let i = 0; i < maxLength; i++) {
    if (domestic[i]) mixed.push(domestic[i]);
    if (international[i]) mixed.push(international[i]);
  }

  const articles = mixed.slice(0, MAX_ARTICLES);

  if (!articles.length) {
    if (cached && cached.articles.length) {
      return jsonResponse({
        ...cached,
        stale: true
      });
    }

    return jsonResponse({
      articles: [],
      count: 0,
      error: "뉴스 출처에 연결하지 못했어요. 잠시 후 다시 시도해 주세요."
    }, 502);
  }

  const categoryCounts = {};

  for (const article of articles) {
    categoryCounts[article.category] =
      (categoryCounts[article.category] || 0) + 1;
  }

  const data = {
    articles,
    count: articles.length,
    domesticCount: articles.filter(
      article => article.region === "국내"
    ).length,
    internationalCount: articles.filter(
      article => article.region === "해외"
    ).length,
    categoryCounts,
    updatedAt: new Date().toISOString()
  };

  await saveNewsCache(ctx, data);

  return jsonResponse(data);
}

function extractAIText(result) {
  if (typeof result === "string") return result;

  if (typeof result?.response === "string") {
    return result.response;
  }

  if (typeof result?.output_text === "string") {
    return result.output_text;
  }

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

  const output = extractAIText(result);

  if (!output.trim()) {
    throw new Error("AI 응답이 비어 있어요.");
  }

  return output;
}

async function summarizeArticle(env, article) {
  const raw = await runAI(env, [
    {
      role: "system",
      content: `너는 초등학교 6학년을 위한 한국어 뉴스 설명자야.
반드시 올바른 JSON만 반환해.
기사에 없는 사실, 인물, 날짜, 숫자를 만들지 마.
최소 5개의 짧은 문장으로 핵심을 설명해.
어려운 단어는 최대 5개 골라 쉬운 말로 풀이해.
자연스러운 한국어를 사용해.
JSON 형식:
{"titleKo":"쉬운 제목","article":"쉬운 설명","terms":[{"term":"어려운 단어","definition":"쉬운 뜻"}]}`
    },
    {
      role: "user",
      content:
        "기사 제목:\n" + article.title +
        "\n\n기사 설명:\n" +
        (article.description || "추가 설명이 없습니다.")
    }
  ], 1800);

  const data = parseJSON(raw);

  const clean = value =>
    String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const articleText = clean(data.article || data.summary);

  if (articleText.length < 20) {
    throw new Error("AI가 충분한 기사 설명을 만들지 못했어요.");
  }

  const terms = Array.isArray(data.terms)
    ? data.terms
        .filter(item =>
          item &&
          typeof item.term === "string" &&
          typeof item.definition === "string"
        )
        .map(item => ({
          term: clean(item.term),
          definition: clean(item.definition)
        }))
        .filter(item => item.term && item.definition)
        .slice(0, 5)
    : [];

  return {
    titleKo: clean(data.titleKo) || article.title,
    article: articleText,
    terms
  };
}

async function searchArticleImage(title) {
  const query = String(title || "").trim().slice(0, 160);

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
    format: "json"
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(
      "https://commons.wikimedia.org/w/api.php?" +
      params.toString(),
      {
        headers: { "Accept": "application/json" },
        signal: controller.signal
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
  } finally {
    clearTimeout(timer);
  }
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
        return await getNews(
          ctx,
          url.searchParams.get("refresh") === "1"
        );
      } catch (error) {
        console.error("뉴스 API 오류:", error?.stack || String(error));

        const cached = await getCachedNews();

        if (cached?.articles?.length) {
          return jsonResponse({
            ...cached,
            stale: true
          });
        }

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
        console.error("AI 요약 오류:", error?.stack || String(error));

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
