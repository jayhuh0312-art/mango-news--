
function buildDigest(articles) {
  const selected = [];

  for (const category of CATEGORIES) {
    // 먼저 해당 분야에 실제로 관련된 기사를 찾습니다.
    const relevant = articles
      .filter(article => article.categories?.includes(category.id))
      .sort((a, b) =>
        (b.score ?? importance(b)) - (a.score ?? importance(a))
      );

    // 관련 기사가 5개보다 적으면 다른 최신 기사로 채웁니다.
    // 따라서 수집된 기사가 충분하면 분야마다 5개씩 표시됩니다.
    const fallback = articles
      .filter(article => !article.categories?.includes(category.id))
      .sort((a, b) =>
        new Date(b.date || 0) - new Date(a.date || 0)
      );

    const combined = [...relevant, ...fallback];
    const seen = new Set();
    const topFive = [];

    for (const article of combined) {
      const key = article.url || article.title;

      if (seen.has(key)) continue;
      seen.add(key);

      topFive.push({
        ...article,
        digestCategory: category.id,
        digestCategoryName: category.name
      });

      if (topFive.length === 5) break;
    }

    selected.push(...topFive);
  }

  return selected;
}
