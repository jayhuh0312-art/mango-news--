
const CACHE_KEY = "mango-news-articles-v1";
const MAX_ARTICLES = 250;

const CATEGORIES = [
  {
    id: "stock",
    name: "주식·투자",
    words: ["주식", "증시", "코스피", "코스닥", "주가", "투자", "상장", "반도체", "나스닥", "주주"]
  },
  {
    id: "finance",
    name: "금융·은행",
    words: ["금리", "은행", "대출", "금융", "환율", "원화", "달러", "예금", "카드", "한국은행"]
  },
  {
    id: "prices",
    name: "물가·생활경제",
    words: ["물가", "소비자물가", "장바구니", "가격", "휘발유", "기름값", "생활비", "식품", "소비", "인플레이션"]
  },
  {
    id: "business",
    name: "기업·산업",
    words: ["기업", "산업", "삼성전자", "현대차", "LG", "SK", "실적", "매출", "공장", "수출"]
  },
  {
    id: "global",
    name: "국제경제·무역",
    words: ["미국", "중국", "일본", "유럽", "무역", "관세", "수출", "수입", "세계경제", "국제경제", "유가"]
  },
  {
    id: "jobs",
    name: "부동산·일자리·정책",
    words: ["부동산", "아파트", "집값", "전세", "월세", "취업", "일자리", "고용", "정부", "정책", "청년", "주택"]
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

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCategories(article) {
  const text = `${article.title} ${article.description}`.toLowerCase();

  return CATEGORIES
    .filter(category =>
      category.words.some(word => text.includes(word.toLowerCase()))
    )
    .map(category => category.id);
}

function importance(article) {
  const text = `${article.title || ""} ${article.description || ""}`.toLowerCase();
  const ageMinutes = Math.max(
    0,
    (Date.now() - new Date(article.date || Date.now()).getTime()) / 60000
  );

  let score = Math.max(0, 100 - ageMinutes * 0.08);

  const importantWords = [
    "급등", "급락", "사상 최대", "긴급", "기준금리", "물가",
    "파산", "인수", "합병", "관세", "실업", "부동산",
    "수출", "실적", "위기", "금융위기", "금리 인하", "금리 인상"
  ];

  for (const word of importantWords) {
    if (text.includes(word)) score += 5;
  }

  return score;
}

async function collectNews() {
  const query = encodeURIComponent(
    '(경제 OR 주식 OR 금융 OR 물가 OR 기업 OR 부동산 OR 금리 OR 무역) language:korean'
  );

  const url =
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}` +
    "&mode=ArtList&format=json&sort=DateDesc&maxrecords=250";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`뉴스 수집 실패: HTTP ${response.status}`);
  }

  const data = await response.json();

  const articles = (data.articles || [])
    .map(item => {
      const date = item.seendate
        ? new Date(item.seendate).toISOString()
        : new Date().toISOString();

      return {
        title: cleanText(item.title),
        description: "",
        url: item.url || "",
        source: item.domain || "뉴스 출처",
        date,
        image: item.socialimage || "",
        categories: []
      };
    })
    .filter(article => article.title && article.url);

  const unique = [...new Map(
    articles.map(article => [article.url, article])
  ).values()];

  for (const article of unique) {
    article.categories = getCategories(article);
    article.score = importance(article);
  }

  return unique;
}

async function readStored(env) {
  if (!env.NEWS_KV) {
    throw new Error("NEWS_KV 저장소가 연결되지 않았어요.");
  }

  const stored = await env.NEWS_KV.get(CACHE_KEY, "json");

  return {
    articles: Array.isArray(stored?.articles) ? stored.articles : [],
    updatedAt: stored?.updatedAt || null
  };
}

async function refreshNews(env) {
  const fresh = await collectNews();
  const old = await readStored(env).catch(() => ({ articles: [] }));

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
  const selected = [];

  for (const category of CATEGORIES) {
    const candidates = articles
      .filter(article => article.categories?.includes(category.id))
      .sort((a, b) => (b.score ?? importance(b)) - (a.score ?? importance(a)));

    if (candidates.length) {
      selected.push({
        ...candidates[0],
        digestCategory: category.id,
        digestCategoryName: category.name
      });
    }
  }

  return selected;
}

async function getAIText(env, prompt) {
  if (!env.AI) {
    throw new Error("Cloudflare Workers AI 바인딩이 연결되지 않았어요.");
  }

  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        {
          role: "system",
          content:
            "너는 한국 초등학생도 이해할 수 있도록 경제 뉴스를 쉽게 설명하는 선생님이야. 기사에 없는 사실은 만들지 마."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 900
    }
  );

  const answer = result.response || result.output_text;

  if (!answer) {
    throw new Error("AI가 설명을 반환하지 않았어요.");
  }

  return answer;
}

async function handleSummary(request, env) {
  const body = await request.json();
  const title = cleanText(body.title);
  const description = cleanText(body.description);

  if (!title) return json({ error: "기사 제목이 필요해요." }, 400);

  const prompt = `다음 경제 뉴스를 초등학생도 이해하도록 설명해 줘.

제목: ${title}
기사 설명: ${description || "추가 설명 없음"}

다음 순서로 작성해 줘.
1. 쉬운 설명: 짧고 쉬운 문장 3~5개
2. 왜 중요할까요?: 한 문장
3. 용어 풀이: 어려운 용어가 있다면 최대 4개를 '용어: 뜻'으로 작성

기사에 없는 내용을 사실처럼 추가하지 마.`;

  const article = await getAIText(env, prompt);

  return json({ article, terms: [] });
}

async function handleImage(request, env) {
  const body = await request.json();
  const title = cleanText(body.title);
  const description = cleanText(body.description);

  if (!title) return json({ error: "기사 제목이 필요해요." }, 400);
  if (!env.AI) return json({ error: "AI 바인딩이 연결되지 않았어요." }, 503);

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-1-schnell",
    {
      prompt:
        `A colorful editorial illustration for a Korean children's economics news website. ` +
        `Topic: ${title}. Context: ${description}. ` +
        "Friendly educational magazine style. No text, no letters, no logos, no watermark.",
      num_steps: 4
    }
  );

  if (result.image) {
    return json({ image: result.image });
  }

  return json({ error: "AI가 그림을 반환하지 않았어요." }, 502);
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

        // 처음 방문했고 저장된 뉴스가 없을 때만 즉시 수집합니다.
        if (!stored.articles.length) {
          stored = await refreshNews(env);
        }

        if (mode === "live") {
          // 실시간 모드는 요청할 때 새 기사를 조회합니다.
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
        return await handleSummary(request, env);
      }

      if (url.pathname === "/api/generate-image" && request.method === "POST") {
        return await handleImage(request, env);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json(
        { error: error.message || "서버에서 문제가 발생했어요." },
        500
      );
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
