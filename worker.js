
const CACHE_KEY = "mango-news-articles-v1";
const MAX_ARTICLES = 300;

const CATEGORIES = [
  { id: "stock", name: "주식·투자", words: ["주식", "증시", "코스피", "코스닥", "주가", "투자", "상장", "나스닥", "반도체", "주주"] },
  { id: "finance", name: "금융·은행", words: ["금리", "은행", "대출", "금융", "환율", "원화", "달러", "예금", "카드", "한국은행"] },
  { id: "prices", name: "물가·생활경제", words: ["물가", "소비자물가", "장바구니", "가격", "휘발유", "기름값", "생활비", "식품", "소비", "인플레이션"] },
  { id: "business", name: "기업·산업", words: ["기업", "산업", "삼성전자", "현대차", "LG", "SK", "실적", "매출", "공장", "수출"] },
  { id: "global", name: "국제경제·무역", words: ["미국", "중국", "일본", "유럽", "무역", "관세", "수출", "수입", "세계경제", "국제경제", "유가"] },
  { id: "jobs", name: "부동산·일자리·정책", words: ["부동산", "아파트", "집값", "전세", "월세", "취업", "일자리", "고용", "정부", "정책", "청년", "주택"] }
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
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function categorise(article) {
  const text = `${article.title} ${article.description}`.toLowerCase();
  return CATEGORIES
    .filter(category => category.words.some(word => text.includes(word.toLowerCase())))
    .map(category => category.id);
}

function score(article) {
  const text = `${article.title} ${article.description}`.toLowerCase();
  const date = new Date(article.date || Date.now()).getTime();
  const ageHours = Math.max(0, (Date.now() - date) / 3600000);
  let result = Math.max(0, 100 - ageHours * 1.5);

  for (const word of ["급등", "급락", "사상 최대", "기준금리", "파산", "인수", "합병", "관세", "금리 인하", "금리 인상", "물가 상승"]) {
    if (text.includes(word)) result += 5;
  }

  return result;
}

async function collectNews() {
  const query = encodeURIComponent(
    '(경제 OR 주식 OR 금융 OR 물가 OR 기업 OR 부동산 OR 금리 OR 무역) sourcelang:korean'
  );

  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}` +
    "&mode=ArtList&format=json&sort=DateDesc&maxrecords=250";

  const response = await fetch(url, {
    headers: { "User-Agent": "MANGO-NEWS/1.0" }
  });

  if (!response.ok) {
    throw new Error(`뉴스 제공처 응답 오류: ${response.status}`);
  }

  const data = await response.json();

  const articles = (data.articles || []).map(item => {
    let date = new Date().toISOString();

    if (item.seendate) {
      const parsed = new Date(item.seendate);
      if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString();
    }

    const article = {
      title: clean(item.title),
      description: "",
      url: item.url || "",
      source: item.domain || "뉴스 제공처",
      date,
      image: item.socialimage || ""
    };

    article.categories = categorise(article);
    article.score = score(article);
    return article;
  }).filter(article => article.title && article.url);

  return [...new Map(articles.map(article => [article.url, article])).values()];
}

async function readStored(env) {
  if (!env.NEWS_KV) {
    throw new Error("NEWS_KV 바인딩을 찾을 수 없어요. Cloudflare 설정을 확인해 주세요.");
  }

  const stored = await env.NEWS_KV.get(CACHE_KEY, "json");

  return {
    articles: Array.isArray(stored?.articles) ? stored.articles : [],
    updatedAt: stored?.updatedAt || null
  };
}

async function refreshNews(env) {
  const fresh = await collectNews();
  const old = await readStored(env);

  const merged = new Map();

  for (const article of [...old.articles, ...fresh]) {
    const previous = merged.get(article.url);

    if (!previous || new Date(article.date) > new Date(previous.date)) {
      merged.set(article.url, article);
    }
  }

  const articles = [...merged.values()]
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

  for (const category of CATEGORIES) {
    const related = articles
      .filter(article => article.categories?.includes(category.id))
      .sort((a, b) => (b.score ?? score(b)) - (a.score ?? score(a)));

    const other = articles
      .filter(article => !article.categories?.includes(category.id))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const seen = new Set();
    const selected = [];

    for (const article of [...related, ...other]) {
      const key = article.url || article.title;
      if (seen.has(key)) continue;

      seen.add(key);
      selected.push({
        ...article,
        digestCategory: category.id,
        digestCategoryName: category.name
      });

      if (selected.length >= 5) break;
    }

    result.push(...selected);
  }

  return result;
}

async function runTextAI(env, prompt) {
  if (!env.AI) {
    throw new Error("AI 바인딩이 없어요. Cloudflare Workers AI 설정을 확인해 주세요.");
  }

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      {
        role: "system",
        content: "너는 경제 뉴스를 초등학생도 이해하도록 쉬운 한국어로 설명하는 선생님이야. 제공되지 않은 사실은 지어내지 마."
      },
      { role: "user", content: prompt }
    ],
    max_tokens: 900
  });

  const text = result?.response || result?.output_text;
  if (!text) throw new Error("AI 응답이 비어 있어요.");
  return text;
}

async function summarize(request, env) {
  const body = await request.json();
  const title = clean(body.title);
  const description = clean(body.description);

  if (!title) return json({ error: "기사 제목이 필요해요." }, 400);

  const article = await runTextAI(env, `다음 경제 뉴스를 초등학생도 이해하도록 설명해 줘.

제목: ${title}
기사 설명: ${description || "제공된 추가 설명 없음"}

쉬운 한국어로 3~5개의 짧은 문장으로 설명하고, 왜 중요한지도 한 문장으로 알려 줘.
마지막에 어려운 용어가 있다면 '용어: 뜻' 형식으로 최대 4개 적어 줘.
기사에 없는 내용을 사실처럼 추가하지 마.`);

  return json({ article, terms: [] });
}

async function generateImage(request, env) {
  const body = await request.json();
  const title = clean(body.title);
  const description = clean(body.description);

  if (!title) return json({ error: "기사 제목이 필요해요." }, 400);
  if (!env.AI) return json({ error: "AI 바인딩이 연결되지 않았어요." }, 503);

  const result = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
    prompt: `Educational editorial illustration for a Korean children's economics news website. Topic: ${title}. Context: ${description}. Friendly magazine illustration, clear shapes, no text, no letters, no logos, no watermark.`,
    num_steps: 4
  });

  if (!result?.image) {
    throw new Error("AI가 그림 데이터를 반환하지 않았어요.");
  }

  return json({ image: result.image });
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
        const mode = url.searchParams.get("mode") || "digest";
        let stored = await readStored(env);

        if (!stored.articles.length) {
          stored = await refreshNews(env);
        }

        if (mode === "live") {
          const articles = await collectNews();

          return json({
            mode: "live",
            articles,
            updatedAt: new Date().toISOString(),
            nextUpdateAt: Date.now() + 30 * 60 * 1000
          });
        }

        return json({
          mode: "digest",
          articles: buildDigest(stored.articles),
          updatedAt: stored.updatedAt,
          nextUpdateAt: stored.updatedAt
            ? new Date(stored.updatedAt).getTime() + 30 * 60 * 1000
            : Date.now() + 30 * 60 * 1000
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
        return await summarize(request, env);
      }

      if (url.pathname === "/api/generate-image" && request.method === "POST") {
        return await generateImage(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: error.message || "서버 오류가 발생했어요." }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshNews(env).catch(error => {
        console.error("예약 뉴스 수집 실패:", error);
      })
    );
  }
};
