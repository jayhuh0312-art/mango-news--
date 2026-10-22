
const CACHE_KEY = "mango-news-articles-v2";
const MAX_ARTICLES = 500;
const CATEGORY_LIMIT = 10;
const UPDATE_INTERVAL = 30 * 60 * 1000;

const CATEGORIES = [
  {
    id: "stock",
    name: "주식·투자",
    words: ["주식", "증시", "코스피", "코스닥", "주가", "투자", "상장", "나스닥", "반도체", "주주", "증권"]
  },
  {
    id: "finance",
    name: "금융·은행",
    words: ["금리", "은행", "대출", "금융", "환율", "원화", "달러", "예금", "한국은행", "채권", "이자"]
  },
  {
    id: "prices",
    name: "물가·생활경제",
    words: ["물가", "소비자물가", "가격", "휘발유", "기름값", "생활비", "식품", "소비", "장바구니", "인플레이션"]
  },
  {
    id: "business",
    name: "기업·산업",
    words: ["기업", "산업", "삼성전자", "현대차", "실적", "매출", "공장", "수출", "제조업", "반도체", "배터리"]
  },
  {
    id: "global",
    name: "국제경제·무역",
    words: ["미국", "중국", "일본", "유럽", "무역", "관세", "수입", "세계경제", "유가", "수출", "국제"]
  },
  {
    id: "jobs",
    name: "부동산·일자리·정책",
    words: ["부동산", "아파트", "집값", "전세", "월세", "취업", "일자리", "고용", "정부", "정책", "주택", "청년"]
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
  const text = `${article.title} ${article.description || ""}`.toLowerCase();

  return CATEGORIES
    .filter(category =>
      category.words.some(word => text.includes(word.toLowerCase()))
    )
    .map(category => category.id);
}

function articleDate(item) {
  if (item.seendate) {
    const parsed = new Date(item.seendate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function importance(article) {
  const parsed = new Date(article.date || Date.now()).getTime();
  const age = Number.isNaN(parsed)
    ? 24
    : Math.max(0, (Date.now() - parsed) / 3600000);

  let score = Math.max(0, 100 - age * 1.5);
  const text = `${article.title} ${article.description || ""}`.toLowerCase();

  for (const word of [
    "급등", "급락", "사상 최대", "기준금리", "파산",
    "인수", "합병", "관세", "금리 인하", "금리 인상"
  ]) {
    if (text.includes(word)) score += 5;
  }

  return score;
}

function makeQuery(words) {
  return `(${words.join(" OR ")}) sourcelang:korean`;
}

async function fetchGdelt(query, maxRecords = 250) {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    sort: "DateDesc",
    maxrecords: String(maxRecords)
  });

  const response = await fetch(
    `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`,
    {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(20000)
    }
  );

  if (!response.ok) {
    throw new Error(`GDELT 뉴스 수집 오류: HTTP ${response.status}`);
  }

  const data = await response.json();

  return (data.articles || []).map(item => {
    const article = {
      title: clean(item.title),
      description: "",
      url: item.url || "",
      source: item.domain || "뉴스 제공처",
      date: articleDate(item),
      image: item.socialimage || ""
    };

    article.categories = classify(article);
    article.score = importance(article);
    return article;
  }).filter(article => article.title && article.url);
}

async function collectNews() {
  const queries = [
    makeQuery([
      "경제", "주식", "금융", "물가", "기업",
      "부동산", "금리", "무역", "투자", "환율"
    ]),
    makeQuery(["주식", "증시", "코스피", "코스닥", "투자", "증권"]),
    makeQuery(["금리", "은행", "대출", "금융", "환율", "예금"]),
    makeQuery(["물가", "가격", "소비자물가", "생활비", "소비"]),
    makeQuery(["기업", "산업", "실적", "매출", "수출", "제조업"]),
    makeQuery(["국제경제", "무역", "관세", "수입", "세계경제"]),
    makeQuery(["부동산", "아파트", "취업", "일자리", "고용", "경제정책"])
  ];

  const results = await Promise.allSettled(
    queries.map(query => fetchGdelt(query, 250))
  );

  const collected = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      collected.push(...result.value);
    } else {
      console.error("일부 뉴스 검색 실패:", result.reason);
    }
  }

  const unique = new Map();

  for (const article of collected) {
    const previous = unique.get(article.url);
    if (!previous || new Date(article.date) > new Date(previous.date)) {
      unique.set(article.url, article);
    }
  }

  const articles = [...unique.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (articles.length === 0) {
    throw new Error("뉴스를 수집하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }

  return articles;
}

async function readNews(env) {
  if (!env.NEWS_KV) {
    throw new Error("NEWS_KV 바인딩이 없어요. Cloudflare KV 설정을 확인해 주세요.");
  }

  const saved = await env.NEWS_KV.get(CACHE_KEY, "json");

  return {
    articles: Array.isArray(saved?.articles) ? saved.articles : [],
    updatedAt: saved?.updatedAt || null
  };
}

async function refreshNews(env) {
  const fresh = await collectNews();

  let previous = { articles: [], updatedAt: null };

  try {
    previous = await readNews(env);
  } catch (error) {
    console.error("기존 뉴스 읽기 실패:", error);
  }

  const combined = new Map();

  for (const article of [...previous.articles, ...fresh]) {
    const existing = combined.get(article.url);

    if (
      !existing ||
      new Date(article.date) > new Date(existing.date)
    ) {
      combined.set(article.url, {
        ...article,
        categories: classify(article),
        score: importance(article)
      });
    }
  }

  const articles = [...combined.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_ARTICLES);

  const result = {
    articles,
    updatedAt: new Date().toISOString()
  };

  await env.NEWS_KV.put(CACHE_KEY, JSON.stringify(result));

  return result;
}

function buildDigest(articles) {
  const result = [];

  // 전체 경제: 최신 기사 10개
  const newest = [...articles]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  for (const article of newest.slice(0, CATEGORY_LIMIT)) {
    result.push({
      ...article,
      digestCategory: "all",
      digestCategoryName: "전체 경제"
    });
  }

  // 각 카테고리: 관련 기사를 우선하고 부족하면 다른 최신 경제 기사로 보충
  for (const category of CATEGORIES) {
    const related = articles
      .filter(article => article.categories?.includes(category.id))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const selected = [];
    const seen = new Set();

    for (const article of related) {
      if (seen.has(article.url)) continue;
      seen.add(article.url);
      selected.push(article);
      if (selected.length >= CATEGORY_LIMIT) break;
    }

    if (selected.length < CATEGORY_LIMIT) {
      for (const article of newest) {
        if (seen.has(article.url)) continue;
        seen.add(article.url);
        selected.push(article);
        if (selected.length >= CATEGORY_LIMIT) break;
      }
    }

    for (const article of selected) {
      result.push({
        ...article,
        digestCategory: category.id,
        digestCategoryName: category.name
      });
    }
  }

  return result;
}

async function runTextAI(env, prompt) {
  if (!env.AI) {
    throw new Error("AI 바인딩이 없어요. Cloudflare Workers AI를 연결해 주세요.");
  }

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      {
        role: "system",
        content: "너는 경제 뉴스를 초등학생도 이해하도록 쉽게 설명하는 선생님이야. 제공되지 않은 사실을 지어내지 마."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: 900
  });

  const answer = result?.response || result?.output_text;

  if (!answer) throw new Error("AI가 설명을 반환하지 않았어요.");

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
마지막에 어려운 용어가 있으면 '용어: 뜻' 형식으로 최대 4개 적어 줘.
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
        `Educational editorial illustration for a Korean children's economics news site. ` +
        `Topic: ${title}. Context: ${description}. ` +
        "Friendly magazine illustration, clear shapes, no text, no logos, no watermark.",
      num_steps: 4
    }
  );

  if (!result?.image) {
    throw new Error("AI 그림 데이터가 비어 있어요.");
  }

  const imageBytes = result.image;
  let binary = "";

  for (let i = 0; i < imageBytes.length; i++) {
    binary += String.fromCharCode(imageBytes[i]);
  }

  return json({
    image: `data:image/png;base64,${btoa(binary)}`
  });
}

export default {
  async fetch(request, env, ctx) {
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
        const mode = url.searchParams.get("mode") || "digest";
        let saved = await readNews(env);

        // 첫 방문 또는 저장된 뉴스가 없으면 즉시 수집을 시도
        if (!saved.articles.length) {
          try {
            saved = await refreshNews(env);
          } catch (error) {
            console.error("최초 뉴스 수집 실패:", error);

            return json({
              mode,
              articles: [],
              updatedAt: null,
              nextUpdateAt: Date.now() + UPDATE_INTERVAL,
              error: "최초 뉴스를 수집하지 못했어요. 잠시 후 새로고침해 주세요."
            }, 503);
          }
        }

        if (mode === "live") {
          // 화면에 최신 뉴스 요청이 오면 실시간 수집을 시도
          try {
            const liveArticles = await collectNews();

            // 최신 수집 결과도 KV에 저장하여 다음 방문 때 활용
            const merged = new Map(
              saved.articles.map(article => [article.url, article])
            );

            for (const article of liveArticles) {
              merged.set(article.url, article);
            }

            const updated = {
              articles: [...merged.values()]
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, MAX_ARTICLES),
              updatedAt: new Date().toISOString()
            };

            await env.NEWS_KV.put(CACHE_KEY, JSON.stringify(updated));

            return json({
              mode: "live",
              articles: updated.articles,
              updatedAt: updated.updatedAt,
              nextUpdateAt: Date.now() + UPDATE_INTERVAL
            });
          } catch (error) {
            console.error("실시간 수집 실패, 저장된 뉴스 표시:", error);

            return json({
              mode: "live",
              articles: saved.articles,
              updatedAt: saved.updatedAt,
              nextUpdateAt: Date.now() + UPDATE_INTERVAL,
              warning: "실시간 수집에 실패해 저장된 뉴스를 표시하고 있어요."
            });
          }
        }

        return json({
          mode: "digest",
          articles: buildDigest(saved.articles),
          updatedAt: saved.updatedAt,
          nextUpdateAt: saved.updatedAt
            ? new Date(saved.updatedAt).getTime() + UPDATE_INTERVAL
            : Date.now() + UPDATE_INTERVAL
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

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("MANGO NEWS ERROR:", error);

      return json({
        error: error.message || "서버 오류가 발생했어요."
      }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      refreshNews(env).catch(error => {
        console.error("예약 뉴스 수집 실패:", error);
      })
    );
  }
};
