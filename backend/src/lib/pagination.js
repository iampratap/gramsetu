export function readPage(query, { defaultSize = 10, maxSize = 50 } = {}) {
  const page = Math.max(1, Number.parseInt(String(query.page || "1"), 10) || 1);
  let pageSize = Number.parseInt(String(query.pageSize || String(defaultSize)), 10) || defaultSize;
  pageSize = Math.min(maxSize, Math.max(1, pageSize));
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

export function pageMeta({ page, pageSize, total }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize) || 1);
  return {
    page,
    pageSize,
    total,
    pageCount,
    hasNext: page < pageCount,
    hasPrev: page > 1,
  };
}
