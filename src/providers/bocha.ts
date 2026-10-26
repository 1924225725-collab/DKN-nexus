import type { SearchProvider } from "./types";

export class BochaSearchProvider implements SearchProvider {
  readonly id = "bocha";
  constructor(private readonly apiKey: string) {}

  async search(query: string, signal?: AbortSignal) {
    const response = await fetch("https://api.bochaai.com/v1/web-search", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, freshness: "noLimit", summary: true, count: 6 }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || payload?.error?.message || `博查搜索请求失败（${response.status}）`);
    const values = payload?.data?.webPages?.value ?? payload?.webPages?.value ?? payload?.data?.value ?? [];
    return values.slice(0, 8).map((item: { name?: string; title?: string; url?: string; snippet?: string; summary?: string; datePublished?: string }) => ({
      title: item.name ?? item.title ?? item.url ?? "未命名结果",
      url: item.url ?? "",
      content: item.summary ?? item.snippet,
      publishedAt: item.datePublished,
    })).filter((item: { url: string }) => Boolean(item.url));
  }
}
