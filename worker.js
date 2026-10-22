
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 실시간 뉴스 API
    if (url.pathname === "/api/news") {
      try {
        const cache = caches.default;
        const cacheKey = new Request(
          new URL("/api/news", url.origin).toString(),
          { method: "GET" }
        );

        // 캐시에 저장된 뉴스가 있으면 먼저 사용
        const cachedResponse = await cache.match(cacheKey);

        if (cachedResponse) {
          return new Response(cachedResponse.body, {
            status: cachedResponse.status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=300"
            }
          });
        }

        // GDELT에서 한국어 경제 뉴스 가져오기
        const query =
          '(경제 OR 주식 OR 금융 OR 물가 OR 기업 OR 부동산 OR 무역) sourcelang:korean';

        const gdeltUrl = new URL(
          "https://api.gdeltproject.org/api/v2/doc/doc"
        );

        gdeltUrl.searchParams.set("query", query);
        gdeltUrl.searchParams.set("mode", "ArtList");
        gdeltUrl.searchParams.set("format", "json");
        gdeltUrl.searchParams.set("maxrecords", "50");
        gdeltUrl.searchParams.set("sort", "DateDesc");

        const newsResponse = await fetch(gdeltUrl.toString(), {
          headers: {
            "User-Agent": "MANGO-NEWS/1.0"
          }
        });

        if (!newsResponse.ok) {
          throw new Error(
            "GDELT 뉴스 요청 실패: " + newsResponse.status
          );
        }

        const data = await newsResponse.json();
        const rawArticles = Array.isArray(data.articles)
          ? data.articles
          : [];

        // 홈페이지에서 사용하기 쉬운 형태로 정리
        const articles = rawArticles
          .filter(article => article.title && article.url)
          .map(article => ({
            title: article.title || "제목 없음",
            description:
              article.description ||
              article.seendate ||
              "기사 설명이 제공되지 않았어요.",
            url: article.url || "",
            domain: article.domain || "",
            date: article.seendate || "",
            image: article.socialimage || ""
          }));

        const result = {
          articles,
          updatedAt: new Date().toISOString()
        };

        const response = new Response(
          JSON.stringify(result),
          {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=300"
            }
          }
        );

        // 뉴스 응답을 5분 동안 캐시에 저장
        ctx.waitUntil(
          cache.put(cacheKey, response.clone())
        );

        return response;

      } catch (error) {
        return new Response(
          JSON.stringify({
            error: "뉴스를 불러오지 못했어요.",
            details: error.message,
            articles: []
          }),
          {
            status: 502,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            }
          }
        );
      }
    }

    // 뉴스 API가 아닌 요청은 public 폴더의 홈페이지로 전달
    return env.ASSETS.fetch(request);
  }
};
