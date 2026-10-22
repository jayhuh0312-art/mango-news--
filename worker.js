
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 뉴스 API
    if (url.pathname === "/api/news") {
      const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      };

      try {
        // GDELT 검색어: 영어 검색어 + 한국어 출처
        const query =
          "(economy OR stocks OR finance OR inflation OR business OR real estate OR trade) sourcelang:korean";

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
            "User-Agent": "MANGO-NEWS/1.0",
            "Accept": "application/json"
          },
          signal: AbortSignal.timeout(20000)
        });

        // GDELT 요청 자체가 실패한 경우
        if (!newsResponse.ok) {
          const errorText = await newsResponse.text();

          return new Response(
            JSON.stringify({
              articles: [],
              error: "GDELT 요청 실패",
              status: newsResponse.status,
              details: errorText.slice(0, 500)
            }),
            {
              status: 502,
              headers
            }
          );
        }

        // GDELT 응답 읽기
        const responseText = await newsResponse.text();
        let data;

        try {
          data = JSON.parse(responseText);
        } catch {
          return new Response(
            JSON.stringify({
              articles: [],
              error: "GDELT가 JSON 형식으로 응답하지 않았어요.",
              details: responseText.slice(0, 500)
            }),
            {
              status: 502,
              headers
            }
          );
        }

        // 기사 목록 확인
        const rawArticles = Array.isArray(data.articles)
          ? data.articles
          : [];

        const articles = rawArticles
          .filter(article => article.title && article.url)
          .map(article => ({
            title: article.title || "제목 없음",
            description:
              article.description ||
              article.title ||
              "기사 설명이 제공되지 않았어요.",
            url: article.url || "",
            domain: article.domain || "",
            date: article.seendate || "",
            image: article.socialimage || ""
          }));

        // 검색 결과가 없으면 원인 확인용 정보 반환
        if (articles.length === 0) {
          return new Response(
            JSON.stringify({
              articles: [],
              error: "GDELT에서 기사를 찾지 못했어요.",
              details: "검색어, GDELT 응답 또는 검색 결과를 확인해야 해요.",
              gdeltArticleCount: rawArticles.length,
              updatedAt: new Date().toISOString()
            }),
            {
              headers
            }
          );
        }

        // 정상 결과
        return new Response(
          JSON.stringify({
            articles,
            updatedAt: new Date().toISOString(),
            count: articles.length
          }),
          {
            headers
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            articles: [],
            error: "뉴스를 불러오지 못했어요.",
            details: error.message || String(error),
            updatedAt: new Date().toISOString()
          }),
          {
            status: 502,
            headers
          }
        );
      }
    }

    // 홈페이지 파일 전달
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
