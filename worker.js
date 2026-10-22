```javascript
const CACHE_KEY = "mango-news-live-v1";
const MAX_ARTICLES = 500;

const CATEGORIES = [
  {
    name: "주식·투자",
    query: "(주식 OR 증시 OR 코스피 OR 코스닥 OR 투자 OR 주가) sourcelang:korean"
  },
  {
    name: "금융·은행",
    query: "(금융 OR 은행 OR 금리 OR 대출 OR 환율 OR 채권) sourcelang:korean"
  },
  {
    name: "물가·생활경제",
    query: "(물가 OR 인플레이션 OR 생활비 OR 소비 OR 유가) sourcelang:korean"
  },
  {
    name: "기업·산업",
    query: "(기업 OR 산업 OR 반도체 OR 자동차 OR 수출) sourcelang:korean"
  },
  {
    name: "국제경제·무역",
    query: "(국제경제 OR 무역 OR 관세 OR 미국경제 OR 중국경제 OR 세계경제) sourcelang:korean"
  },
  {
    name: "부동산·일자리·정책",
    query: "(부동산 OR 집값 OR 취업 OR 일자리 OR 고용 OR 경제정책) sourcelang:korean"
  },
  {
    name: "전체 경제",
    query: "(경제 OR 금융시장 OR 경제성장 OR 경기전망 OR 기업실적) sourcelang:korean"
  }
];

function reply(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function clean(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function categoryFor(title, description) {
  const text = (title + " " + description).toLowerCase();

  const rules = [
    {
      name: "주식·투자",
      words: ["주식", "증시", "코스피", "코스닥", "투자", "주가", "상장"]
    },
    {
      name: "금융·은행",
      words: ["금융", "은행", "금리", "대출", "환율", "채권", "예금"]
    },
    {
      name: "물가·생활경제",
      words: ["물가", "인플레이션", "생활비", "소비자물가", "유가", "소비"]
    },
    {
      name: "기업·산업",
      words: ["기업", "산업", "반도체", "삼성전자", "자동차", "수출", "공장"]
    },
    {
      name: "국제경제·무역",
      words: ["국제경제", "무역", "관세", "미국경제", "중국경제", "세계경제", "수입"]
    },
    {
      name: "부동산·일자리·정책",
      words: ["부동산", "집값", "취업", "일자리", "고용", "경제정책", "아파트", "주택"]
    }
  ];

  for (const rule of rules) {
    for (const word of rule.words) {
      if (text.includes(word.toLowerCase())) {
        return rule.name;
      }
    }
  }

  return "전체 경제";
}

function normalize(item) {
  const title = clean(item.title);
  const description = clean(item.description || "");

  if (!title) {
    return null;
  }

  const url = item.url || "";

  return {
    id: url || title,
    title: title,
    description: description,
    url: url,
    source: item.domain || "",
    publishedAt: item.seendate || "",
    category: categoryFor(title, description),
    image: item.socialimage || ""
  };
}

async function fetchQuery(query) {
  const params = new URLSearchParams();

  params.set("query", query);
  params.set("mode", "ArtList");
  params.set("format", "json");
  params.set("maxrecords", "100");
  params.set("sort", "DateDesc");
  params.set("timespan", "1d");

  const endpoint =
    "https://api.gdeltproject.org/api/v2/doc/doc?" +
    params.toString();

  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "MangoNews/1.0"
    }
  });

  if (!response.ok) {
    throw new Error("뉴스 제공 서버 오류: HTTP " + response.status);
  }

  const data = await response.json();

  if (!Array.isArray(data.articles)) {
    return [];
  }

  return data.articles.map(normalize).filter(Boolean);
}

async function collectNews() {
  const articles = [];
  const errors = [];

  for (const category of CATEGORIES) {
    try {
      const results = await fetchQuery(category.query);
      articles.push.apply(articles, results);
    } catch (error) {
      errors.push(category.name + ": " + error.message);
    }
  }

  const unique = new Map();

  for (const article of articles) {
    const key = article.url || article.title;

    if (!unique.has(key)) {
      unique.set(key, article);
    }
  }

  const result = Array.from(unique.values());

  result.sort(function (a, b) {
    return String(b.publishedAt).localeCompare(String(a.publishedAt));
  });

  if (result.length === 0) {
    throw new Error(
      "뉴스를 가져오지 못했어요. " +
      (errors.join(" / ") || "검색 결과가 없어요.")
    );
  }

  return result.slice(0, MAX_ARTICLES);
}

function groupArticles(articles) {
  const groups = {
    "전체 경제": [],
    "주식·투자": [],
    "금융·은행": [],
    "물가·생활경제": [],
    "기업·산업": [],
    "국제경제·무역": [],
    "부동산·일자리·정책": []
  };

  for (const article of articles) {
    if (groups["전체 경제"].length < 10) {
      groups["전체 경제"].push(article);
    }

    const name = article.category;

    if (groups[name] && groups[name].length < 10) {
      groups[name].push(article);
    }
  }

  return groups;
}

async function newsAPI(env) {
  try {
    const articles = await collectNews();

    if (env.NEWS_KV) {
      try {
        await env.NEWS_KV.put(
          CACHE_KEY,
          JSON.stringify(articles)
        );
      } catch (error) {
        console.log("뉴스 캐시 저장 실패: " + error.message);
      }
    }

    return reply({
      success: true,
      mode: "live",
      live: true,
      articles: articles,
      categories: groupArticles(articles),
      updatedAt: new Date().toISOString(),
      warning: ""
    });
  } catch (error) {
    let saved = [];

    if (env.NEWS_KV) {
      try {
        saved = await env.NEWS_KV.get(CACHE_KEY, "json");
      } catch (ignored) {
        saved = [];
      }
    }

    if (Array.isArray(saved) && saved.length > 0) {
      return reply({
        success: true,
        mode: "live",
        live: false,
        articles: saved,
        categories: groupArticles(saved),
        updatedAt: null,
        warning: "새 뉴스를 가져오지 못해 이전 뉴스를 보여 줍니다. " +
          error.message
      });
    }

    return reply({
      success: false,
      error: error.message
    }, 502);
  }
}

async function runAI(env, prompt) {
  if (!env.AI) {
    throw new Error(
      "AI 바인딩이 없습니다. Cloudflare에서 AI 바인딩 이름을 AI로 설정해 주세요."
    );
  }

  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        {
          role: "system",
          content:
            "너는 초등학생도 이해할 수 있도록 경제 뉴스를 설명하는 선생님이야. " +
            "쉬운 한국어로 설명하고, 어려운 경제 용어는 풀어서 알려 줘. " +
            "기사에 없는 사실은 만들지 마."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 700
    }
  );

  if (!result || !result.response) {
    throw new Error("AI가 설명을 반환하지 않았어요.");
  }

  return result.response.trim();
}

async function summaryAPI(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    return reply({ error: "요청 내용을 읽을 수 없어요." }, 400);
  }

  const article = body.article || body;

  if (!article.title) {
    return reply({ error: "기사 제목이 없어요." }, 400);
  }

  const prompt =
    "다음 경제 뉴스를 초등학생이 이해하도록 설명해 줘.\n" +
    "제목: " + article.title + "\n" +
    "기사 설명: " + (article.description || "") + "\n\n" +
    "다음 순서로 작성해 줘.\n" +
    "1. 쉬운 제목\n" +
    "2. 무슨 일이 일어났나요?\n" +
    "3. 왜 중요한가요?\n" +
    "4. 우리 생활과 어떤 관계가 있나요?\n" +
    "5. 어려운 경제 용어 풀이\n" +
    "기사에 없는 사실이나 수치는 만들어 내지 마.";

  try {
    const summary = await runAI(env, prompt);

    return reply({
      success: true,
      summary: summary
    });
  } catch (error) {
    return reply({
      error: "AI 요약 실패: " + error.message
    }, 500);
  }
}

async function imageAPI(request, env) {
  let body;

  try {
    body = await request.json();
  } catch (error) {
    return reply({ error: "요청 내용을 읽을 수 없어요." }, 400);
  }

  const article = body.article || body;

  if (!article.title) {
    return reply({ error: "기사 제목이 없어요." }, 400);
  }

  if (!env.AI) {
    return reply({
      error: "Cloudflare AI 바인딩을 찾을 수 없어요."
    }, 500);
  }

  const prompt =
    "Create a colorful editorial cartoon illustration for a Korean children's economics news website. " +
    "Topic: " + article.title + ". " +
    "Description: " + (article.description || "") + ". " +
    "Friendly educational cartoon, mango yellow accents, clean composition, " +
    "no text, no letters, no logos, no watermark.";

  try {
    const result = await env.AI.run(
      "@cf/black-forest-labs/flux-1-schnell",
      {
        prompt: prompt,
        num_steps: 4
      }
    );

    if (!result || !result.image) {
      throw new Error("AI가 그림 데이터를 반환하지 않았어요.");
    }

    return reply({
      success: true,
      image: "data:image/jpeg;base64," + result.image
    });
  } catch (error) {
    return reply({
      error: "AI 그림 생성 실패: " + error.message
    }, 500);
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

    if (path === "/api/health") {
      return reply({
        success: true,
        worker: "MANGO NEWS",
        aiBinding: Boolean(env.AI),
        kvBinding: Boolean(env.NEWS_KV),
        time: new Date().toISOString()
      });
    }

    if (path === "/api/news" && request.method === "GET") {
      return await newsAPI(env);
    }

    if (path === "/api/summarize" && request.method === "POST") {
      return await summaryAPI(request, env);
    }

    if (path === "/api/generate-image" && request.method === "POST") {
      return await imageAPI(request, env);
    }

    if (env.ASSETS) {
      return await env.ASSETS.fetch(request);
    }

    return new Response("MANGO NEWS Worker is running.", {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      }
    });
  }
};
```
