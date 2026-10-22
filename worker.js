```javascript
const CACHE_KEY = "mango-news-articles-v3";
const MAX_ARTICLES = 500;
const CATEGORY_LIMIT = 10;

const CATEGORY_QUERIES = [
  {
    name: "주식·투자",
    query: '(주식 OR 증시 OR 코스피 OR 코스닥 OR 투자 OR 주가) sourcelang:korean'
  },
  {
    name: "금융·은행",
    query: '(금융 OR 은행 OR 금리 OR 대출 OR 환율 OR 채권) sourcelang:korean'
  },
  {
    name: "물가·생활경제",
    query: '(물가 OR 소비자물가 OR 인플레이션 OR 생활비 OR 소비 OR 유가) sourcelang:korean'
  },
  {
    name: "기업·산업",
    query: '(기업 OR 산업 OR 반도체 OR 자동차 OR 삼성전자 OR 수출) sourcelang:korean'
  },
  {
    name: "국제경제·무역",
    query: '(국제경제 OR 무역 OR 관세 OR 미국경제 OR 중국경제 OR 세계경제) sourcelang:korean'
  },
  {
    name: "부동산·일자리·정책",
    query: '(부동산 OR 집값 OR 취업 OR 일자리 OR 고용 OR 경제정책) sourcelang:korean'
  },
  {
    name: "전체 경제",
    query: '(경제 OR 금융시장 OR 경제성장 OR 경기전망 OR 기업실적) sourcelang:korean'
  }
];

const CATEGORY_KEYWORDS = {
  "주식·투자": [
    "주식", "증시", "코스피", "코스닥", "투자", "주가", "상장", "주주"
  ],
  "금융·은행": [
    "금융", "은행", "금리", "대출", "환율", "채권", "예금", "중앙은행"
  ],
  "물가·생활경제": [
    "물가", "인플레이션", "생활비", "소비자물가", "유가", "소비", "가격"
  ],
  "기업·산업": [
    "기업", "산업", "반도체", "삼성전자", "자동차", "수출", "공장", "기술"
  ],
  "국제경제·무역": [
    "국제경제", "무역", "관세", "미국경제", "중국경제", "세계경제",
    "수입", "달러", "유럽", "국제"
  ],
  "부동산·일자리·정책": [
    "부동산", "집값", "취업", "일자리", "고용", "경제정책", "아파트",
    "주택", "청년고용"
  ]
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCategory(article) {
  const text = (
    (article.title || "") + " " +
    (article.description || "")
  ).toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(keyword => text.includes(keyword.toLowerCase()))) {
      return category;
    }
  }

  return "전체 경제";
}

function normalizeArticle(item) {
  const title = cleanText(item.title);
  const description = cleanText(
    item.description || item.seendate || ""
  );

  if (!title) {
    return null;
  }

  const url = item.url || "";

  return {
    id: url || title,
    title,
    description,
    url,
    source: item.domain || "",
    publishedAt: item.seendate || "",
    category: getCategory({
      title,
      description
    }),
    image: item.socialimage || ""
  };
}

async function fetchGdelt(query, maxRecords = 100) {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    maxrecords: String(maxRecords),
    sort: "DateDesc",
    timespan: "1d"
  });

  const url =
    "https://api.gdeltproject.org/api/v2/doc/doc?" +
    params.toString();

  let response;

  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": "MangoNews/1.0"
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error("GDELT에 연결하지 못했어요: " + error.message);
  }

  if (!response.ok) {
    throw new Error(
      "GDELT 요청 실패: HTTP " + response.status
    );
  }

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error("GDELT가 올바른 JSON 데이터를 보내지 않았어요.");
  }

  if (!Array.isArray(data.articles)) {
    return [];
  }

  return data.articles
    .map(normalizeArticle)
    .filter(Boolean);
}

async function collectNews() {
  const allArticles = [];
  const errors = [];

  for (let i = 0; i < CATEGORY_QUERIES.length; i += 2) {
    const batch = CATEGORY_QUERIES.slice(i, i + 2);

    const results = await Promise.allSettled(
      batch.map(item => fetchGdelt(item.query, 100))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];

      if (result.status === "fulfilled") {
        allArticles.push(...result.value);
      } else {
        errors.push(
          batch[j].name + ": " + result.reason.message
        );
      }
    }
  }

  const unique = new Map();

  for (const article of allArticles) {
    const key = article.url || article.title;

    if (!unique.has(key)) {
      unique.set(key, article);
    }
  }

  let articles = Array.from(unique.values());

  if (articles.length === 0) {
    throw new Error(
      errors.length
        ? errors.join(" / ")
        : "최근 뉴스가 검색되지 않았어요."
    );
  }

  articles.sort((a, b) => {
    return String(b.publishedAt).localeCompare(
      String(a.publishedAt)
    );
  });

  return articles.slice(0, MAX_ARTICLES);
}

async function readNews(env) {
  if (!env.NEWS_KV) {
    throw new Error(
      "NEWS_KV 바인딩이 없어요. Cloudflare에서 KV를 연결해 주세요."
    );
  }

  const saved = await env.NEWS_KV.get(CACHE_KEY, "json");

  if (!Array.isArray(saved)) {
    return [];
  }

  return saved;
}

async function saveNews(env, articles) {
  if (!env.NEWS_KV) {
    throw new Error(
      "NEWS_KV 바인딩이 없어요. Cloudflare에서 KV를 연결해 주세요."
    );
  }

  await env.NEWS_KV.put(
    CACHE_KEY,
    JSON.stringify(articles)
  );
}

function buildCategories(articles) {
  const result = {
    "전체 경제": [],
    "주식·투자": [],
    "금융·은행": [],
    "물가·생활경제": [],
    "기업·산업": [],
    "국제경제·무역": [],
    "부동산·일자리·정책": []
  };

  for (const article of articles) {
    const category = article.category || "전체 경제";

    if (result[category] && result[category].length < CATEGORY_LIMIT) {
      result[category].push(article);
    }

    if (result["전체 경제"].length < CATEGORY_LIMIT) {
      if (!result["전체 경제"].some(item => item.id === article.id)) {
        result["전체 경제"].push(article);
      }
    }
  }

  return result;
}

async function getLiveNews(env) {
  try {
    const articles = await collectNews();

    await saveNews(env, articles);

    return {
      mode: "live",
      live: true,
      articles,
      categories: buildCategories(articles),
      updatedAt: new Date().toISOString(),
      warning: ""
    };
  } catch (error) {
    let saved = [];

    try {
      saved = await readNews(env);
    } catch {
      // KV에서 저장된 기사를 읽을 수 없으면 아래에서 오류를 안내해요.
    }

    if (saved.length > 0) {
      return {
        mode: "live",
        live: false,
        articles: saved,
        categories: buildCategories(saved),
        updatedAt: null,
        warning:
          "새 뉴스를 가져오지 못해 저장된 뉴스를 보여 주고 있어요. 원인: " +
          error.message
      };
    }

    throw error;
  }
}

async function runTextAI(env, prompt) {
  if (!env.AI) {
    throw new Error(
      "Cloudflare AI 바인딩을 찾을 수 없어요. AI 바인딩 이름이 AI인지 확인해 주세요."
    );
  }

  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        {
          role: "system",
          content:
            "너는 한국 초등학생도 이해할 수 있게 경제 뉴스를 설명하는 친절한 선생님이야. " +
            "쉬운 한국어를 사용하고, 어려운 경제 용어는 풀어서 설명해. " +
            "기사에 없는 사실을 만들어 내지 마. " +
            "핵심 내용을 짧은 문단과 목록으로 정리해."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 700,
      temperature: 0.4
    }
  );

  const text =
    result && result.response
      ? result.response
      : "";

  if (!text) {
    throw new Error("AI가 설명을 만들어 내지 못했어요.");
  }

  return text.trim();
}

async function handleSummary(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: "요청 내용을 읽을 수 없어요." },
      400
    );
  }

  const article = body.article || body;

  if (!article.title) {
    return jsonResponse(
      { error: "기사 제목이 없어요." },
      400
    );
  }

  const text =
    `${article.title || ""} ${article.description || ""}`;

  const prompt =
    "다음 경제 뉴스를 초등학생이 이해할 수 있도록 설명해 줘.\n\n" +
    "제목: " + (article.title || "") + "\n" +
    "기사 설명: " + (article.description || "") + "\n\n" +
    "다음 순서로 작성해 줘.\n" +
    "1. 쉬운 제목\n" +
    "2. 무슨 일이 일어났나요?\n" +
    "3. 왜 중요한가요?\n" +
    "4. 우리 생활에 어떤 영향을 줄 수 있나요?\n" +
    "5. 꼭 알아둘 경제 용어\n\n" +
    "기사에 없는 구체적인 사실이나 수치를 만들어 내지 마.";

  try {
    const summary = await runTextAI(env, prompt);

    return jsonResponse({
      success: true,
      summary
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "AI 요약 실패: " + error.message
      },
      500
    );
  }
}

async function handleImage(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { error: "요청 내용을 읽을 수 없어요." },
      400
    );
  }

  const article = body.article || body;

  if (!article.title) {
    return jsonResponse(
      { error: "기사 제목이 없어요." },
      400
    );
  }

  if (!env.AI) {
    return jsonResponse(
      {
        error:
          "Cloudflare AI 바인딩을 찾을 수 없어요. AI 바인딩 이름이 AI인지 확인해 주세요."
      },
      500
    );
  }

  const prompt =
    "Create a clear, colorful editorial illustration for a Korean children's economics news website. " +
    "Topic: " + article.title + ". " +
    "Description: " + (article.description || "") + ". " +
    "Friendly educational cartoon style, mango yellow accents, clean composition, " +
    "no text, no letters, no logos, no watermarks.";

  try {
    const result = await env.AI.run(
      "@cf/black-forest-labs/flux-1-schnell",
      {
        prompt,
        num_steps: 4
      }
    );

    let imageData = null;

    if (result && result.image) {
      imageData = result.image;
    } else if (result && result.data) {
      imageData = result.data;
    }

    if (!imageData) {
      throw new Error("AI가 그림 데이터를 반환하지 않았어요.");
    }

    return jsonResponse({
      success: true,
      image: "data:image/jpeg;base64," + imageData
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "AI 그림 생성 실패: " + error.message
      },
      500
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    try {
      if (path === "/api/news") {
        const result = await getLiveNews(env);

        return jsonResponse(result);
      }

      if (path === "/api/summarize" && request.method === "POST") {
        return await handleSummary(request, env);
      }

      if (
        path === "/api/generate-image" &&
        request.method === "POST"
      ) {
        return await handleImage(request, env);
      }

      if (path === "/api/health") {
        return jsonResponse({
          success: true,
          message: "MANGO NEWS Worker is running.",
          aiBinding: Boolean(env.AI),
          kvBinding: Boolean(env.NEWS_KV),
          time: new Date().toISOString()
        });
      }

      if (env.ASSETS) {
        return await env.ASSETS.fetch(request);
      }

      return new Response(
        "MANGO NEWS Worker is running. Check your Assets binding.",
        {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        }
      );
    } catch (error) {
      return jsonResponse(
        {
          error:
            error && error.message
              ? error.message
              : "알 수 없는 서버 오류가 발생했어요."
        },
        500
      );
    }
  }
};
```
