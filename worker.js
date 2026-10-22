```javascript
const CACHE_KEY = "mango-news-articles-v3";
const MAX_ARTICLES = 500;
const CATEGORY_LIMIT = 10;

const CATEGORIES = [
  {
    id: "stock",
    name: "주식·투자",
    words: ["주식", "증시", "코스피", "코스닥", "주가", "투자", "상장", "나스닥", "증권", "주주", "반도체"]
  },
  {
    id: "finance",
    name: "금융·은행",
    words: ["금리", "은행", "대출", "금융", "환율", "원화", "달러", "예금", "한국은행", "채권", "이자"]
  },
  {
    id: "prices",
    name: "물가·생활경제",
    words: ["물가", "소비자물가", "가격", "휘발유", "기름값", "생활비", "식품", "소비", "인플레이션"]
  },
  {
    id: "business",
    name: "기업·산업",
    words: ["기업", "산업", "삼성전자", "현대차", "실적", "매출", "공장", "수출", "제조업", "배터리"]
  },
  {
    id: "global",
    name: "국제경제·무역",
    words: ["미국", "중국", "일본", "유럽", "무역", "관세", "수입", "세계경제", "유가", "국제경제"]
  },
  {
    id: "jobs",
    name: "부동산·일자리·정책",
    words: ["부동산", "아파트", "집값", "전세", "월세", "취업", "일자리", "고용", "정부", "정책", "주택"]
  }
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

function clean(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classify(article) {
  const text = `${article.title || ""} ${article.description || ""}`.toLowerCase();

  return CATEGORIES
    .filter(category =>
      category.words.some(word => text.includes(word.toLowerCase()))
    )
    .map(category => category.id);
}

function getDate(item) {
  if (item.seendate) {
    const date = new Date(item.seendate);

    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return item.date || new Date().toISOString();
}

function normalizeArticle(item) {
  const article = {
    title: clean(item.title),
    description: clean(item.description || ""),
    url: item.url || item.link || "",
    source: item.domain || item.source || "뉴스 제공처",
    date: getDate(item),
    image: item.image || item.socialimage || ""
  };

  article.categories = classify(article);
  return article;
}

async function fetchGdelt(query, maxRecords = 250) {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    sort: "DateDesc",
    maxrecords: String(maxRecords),
    timespan: "1d"
  });

  const response = await fetch(
    `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`,
    {
      headers: {
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(25000)
    }
  );

  if (!response.ok) {
    throw new Error(`GDELT 요청 실패: HTTP ${response.status}`);
  }

  const responseText = await response.text();

  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `GDELT 응답을 JSON으로 읽지 못했어요: ${responseText.slice(0, 180)}`
    );
  }

  if (!Array.isArray(data.articles)) {
    if (data.error) {
      throw new Error(`GDELT 오류: ${String(data.error).slice(0, 180)}`);
    }

    return [];
  }

  return data.articles
    .map(item => normalizeArticle({
      title: item.title,
      description: item.description || "",
      url: item.url,
      domain: item.domain,
      seendate: item.seendate,
      socialimage: item.socialimage
    }))
    .filter(article => article.title && article.url);
}

async function collectNews() {
  const queries = [
    '(경제 OR 주식 OR 금융 OR 물가 OR 기업 OR 부동산 OR 금리 OR 무역 OR 투자) sourcelang:korean',
    '(주식 OR 증시 OR 코스피 OR 코스닥 OR 투자 OR 증권) sourcelang:korean',
    '(금리 OR 은행 OR 대출 OR 금융 OR 환율 OR 예금) sourcelang:korean',
    '(물가 OR 가격 OR 소비자물가 OR 생활비 OR 소비) sourcelang:korean',
    '(기업 OR 산업 OR 실적 OR 매출 OR 수출 OR 제조업) sourcelang:korean',
    '(국제경제 OR 무역 OR 관세 OR 수입 OR 세계경제) sourcelang:korean',
    '(부동산 OR 아파트 OR 취업 OR 일자리 OR 고용 OR 경제정책) sourcelang:korean'
  ];

  const collected = [];
  const errors = [];

  // 요청을 한 번에 너무 많이 보내지 않도록 2개씩 검색
  for (let i = 0; i < queries.length; i += 2) {
    const batch = queries.slice(i, i + 2);

    const results = await Promise.allSettled(
      batch.map(query => fetchGdelt(query, 100))
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        collected.push(...result.value);
      } else {
        const message = result.reason?.message || String(result.reason);
        errors.push(message);
        console.error("GDELT 검색 실패:", message);
      }
    }
  }

  // 모든 한국어 검색이 실패하면 영어 검색어로 한 번 더 시도
  if (collected.length === 0) {
    try {
      const fallback = await fetchGdelt(
        '(economy OR stocks OR finance OR inflation OR business OR trade) sourcelang:korean',
        100
      );

      collected.push(...fallback);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  const unique = new Map();

  for (const article of collected) {
    const previous = unique.get(article.url);

    if (
      !previous ||
      new Date(article.date) > new Date(previous.date)
    ) {
      unique.set(article.url, article);
    }
  }

  const articles = [...unique.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (articles.length === 0) {
    const detail = errors.length
      ? errors.slice(0, 2).join(" / ")
      : "검색 결과가 0개예요.";

    throw new Error(`뉴스를 가져오지 못했어요. ${detail}`);
  }

  return articles;
}

async function readNews(env) {
  if (!env.NEWS_KV) {
    throw new Error(
      "NEWS_KV 바인딩을 찾을 수 없어요. Cloudflare에서 KV 연결을 확인해 주세요."
    );
  }

  const saved = await env.NEWS_KV.get(CACHE_KEY, "json");

  return {
    articles: Array.isArray(saved?.articles) ? saved.articles : [],
    updatedAt: saved?.updatedAt || null
  };
}

async function saveNews(env, newArticles) {
  const previous = await readNews(env);
  const combined = new Map();

  for (const article of [...previous.articles, ...newArticles]) {
    if (!article.url) continue;

    const normalized = normalizeArticle(article);
    const existing = combined.get(normalized.url);

    if (
      !existing ||
      new Date(normalized.date) > new Date(existing.date)
    ) {
      combined.set(normalized.url, normalized);
    }
  }

  const result = {
    articles: [...combined.values()]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, MAX_ARTICLES),
    updatedAt: new Date().toISOString()
  };

  await env.NEWS_KV.put(CACHE_KEY, JSON.stringify(result));

  return result;
}

async function refreshNews(env) {
  const fresh = await collectNews();
  return await saveNews(env, fresh);
}

function buildCategories(articles) {
  const newest = [...articles].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  const result = [];

  for (const article of newest.slice(0, CATEGORY_LIMIT)) {
    result.push({
      ...article,
      digestCategory: "all",
      digestCategoryName: "전체 경제"
    });
  }

  for (const category of CATEGORIES) {
    const related = newest.filter(article =>
      article.categories?.includes(category.id)
    );

    for (const article of related.slice(0, CATEGORY_LIMIT)) {
      result.push({
        ...article,
        digestCategory: category.id,
        digestCategoryName: category.name
      });
    }
  }

  return result;
}

async function getLiveNews(env) {
  let freshError = null;

  try {
    const fresh = await collectNews();
    const saved = await saveNews(env, fresh);

    return {
      articles: buildCategories(saved.articles),
      updatedAt: saved.updatedAt,
      live: true,
      warning: null
    };
  } catch (error) {
    freshError = error;
    console.error("실시간 뉴스 수집 실패:", error);
  }

  try {
    const saved = await readNews(env);

    if (saved.articles.length > 0) {
      return {
        articles: buildCategories(saved.articles),
        updatedAt: saved.updatedAt,
        live: false,
        warning:
          "최신 뉴스 수집에 실패해 저장된 뉴스를 표시하고 있어요. " +
          (freshError?.message || "")
      };
    }
  } catch (storageError) {
    console.error("저장된 뉴스 확인 실패:", storageError);
    throw storageError;
  }

  throw freshError || new Error("뉴스를 가져오지 못했어요.");
}

async function runTextAI(env, prompt) {
  if (!env.AI) {
    throw new Error(
      "AI 바인딩이 없어요. Cloudflare Workers AI를 연결해 주세요."
    );
  }

  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        {
          role: "system",
          content:
            "너는 경제 뉴스를 초등학생도 이해하도록 쉽게 설명하는 선생님이야. " +
            "제공되지 않은 사실을 지어내지 마."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 900
    }
  );

  const answer = result?.response || result?.output_text;

  if (!answer) {
    throw new Error("AI가 설명을 반환하지 않았어요.");
  }

  return answer;
}

async function handleSummary(request, env) {
  const body = await request.json();
  const title = clean(body.title);
  const description = clean(body.description);

  if (!title) {
    return json({ error: "기사 제목이 필요해요." }, 400);
  }

  const article = await runTextAI(env, `
다음 경제 뉴스를 초등학생도 이해할 수 있게 설명해 줘.

제목: ${title}
기사 설명: ${description || "추가 설명 없음"}

3~5개의 짧은 문장으로 설명하고, 왜 중요한지 알려 줘.
어려운 용어가 있으면 마지막에 '용어: 뜻' 형식으로 최대 4개 적어 줘.
기사에 없는 사실은 추가하지 마.
`);

  return json({ article, terms: [] });
}

async function handleImage(request, env) {
  const body = await request.json();
  const title = clean(body.title);
  const description = clean(body.description);

  if (!title) {
    return json({ error: "기사 제목이 필요해요." }, 400);
  }

  if (!env.AI) {
    return json({ error: "AI 바인딩이 없어요." }, 503);
  }

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-1-schnell",
    {
      prompt:
        "Educational editorial illustration for a Korean children's economics news site. " +
        `Topic: ${title}. Context: ${description}. ` +
        "Friendly magazine illustration, clear shapes, no text, no logos, no watermark.",
      num_steps: 4
    }
  );

  if (!result?.image) {
    throw new Error("AI 그림 데이터가 비어 있어요.");
  }

  const bytes = result.image;
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return json({
    image: `data:image/png;base64,${btoa(binary)}`
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    try {
      if (url.pathname === "/api/news" && request.method === "GET") {
        const result = await getLiveNews(env);

        return json({
          mode: "live",
          articles: result.articles,
          updatedAt: result.updatedAt,
          live: result.live,
          warning: result.warning
        });
      }

      if (url.pathname === "/api/refresh" && request.method === "POST") {
        const result = await refreshNews(env);

        return json({
          ok: true,
          count: result.articles.length,
          updatedAt: result.updatedAt
        });
      }

      if (url.pathname === "/api/summarize" && request.method === "POST") {
        return await handleSummary(request, env);
      }

      if (url.pathname === "/api/generate-image" && request.method === "POST") {
        return await handleImage(request, env);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("MANGO NEWS is running.", { status: 200 });
    } catch (error) {
      console.error("MANGO NEWS ERROR:", error);

      return json({
        error: error.message || "서버 오류가 발생했어요."
      }, 500);
    }
  }
};
```
