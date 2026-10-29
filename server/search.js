const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

export function createSearchProvider({
  providerName = process.env.WEB_SEARCH_PROVIDER || 'none',
  apiKey = process.env.BRAVE_SEARCH_API_KEY,
  fetchImpl = fetch,
} = {}) {
  if (providerName === 'none') {
    return { enabled: false, search: async () => [] };
  }
  if (providerName !== 'brave') {
    throw new Error(`Unsupported web search provider: ${providerName}`);
  }

  return {
    enabled: true,
    async search(query) {
      if (!apiKey) throw new Error('Brave Search is configured but BRAVE_SEARCH_API_KEY is missing');
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', String(query).slice(0, 512));
      url.searchParams.set('count', String(MAX_RESULTS));
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Brave Search returned HTTP ${response.status}`);
      const data = await response.json();
      const results = Array.isArray(data.web?.results) ? data.web.results : [];
      return results.flatMap((result) => {
        if (typeof result.title !== 'string' || typeof result.url !== 'string' || typeof result.description !== 'string') return [];
        let parsedUrl;
        try {
          parsedUrl = new URL(result.url);
        } catch {
          return [];
        }
        if (parsedUrl.protocol !== 'https:') return [];
        return [{
          kind: 'web',
          title: result.title.slice(0, 300),
          url: parsedUrl.href,
          date: typeof result.page_age === 'string' ? result.page_age.slice(0, 100) : '',
          content: result.description.slice(0, 1200),
        }];
      }).slice(0, MAX_RESULTS);
    },
  };
}
