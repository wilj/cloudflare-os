// The SearXNG JSON API, and the mapping from its answer to the shape an agent sees.
//
// Kept free of Workers types so it can be tested as plain functions: everything here takes a
// fetcher and a base URL rather than reaching for `env`.
//
// SearXNG is a metasearch front end, so which engine actually answers is deployment configuration
// (`settings.yml`), not a decision this file makes. That indirection is the point — swapping the
// search provider must not be a code change.

export type WebSearchOptions = {
  /** How many results to return. Clamped to MAX_RESULTS. */
  limit?: number;
  /** SearXNG category, e.g. "general", "news", "science", "it". Defaults to the instance's. */
  category?: string;
  /** Two-letter language code, e.g. "en". Defaults to the instance's. */
  language?: string;
  /** Restrict to recently published pages. */
  timeRange?: "day" | "week" | "month" | "year";
};

export type WebSearchResult = {
  title: string;
  url: string;
  /** The snippet or extract the engine returned. May be empty. */
  content: string;
  /** ISO 8601, when the engine reported one. */
  publishedDate?: string;
  /** Which configured engine produced this result — "exaapi", "duckduckgo", … */
  engine: string;
};

export const DEFAULT_RESULT_LIMIT = 10;
export const MAX_RESULT_LIMIT = 25;
export const MAX_QUERY_LENGTH = 500;
const REQUEST_TIMEOUT_MS = 25_000;
const TIME_RANGES = new Set(["day", "week", "month", "year"]);

// POST rather than GET: SearXNG's `server.method` defaults to "POST" and rejects a GET /search
// with 405. POST works whichever way the deployment has set it.
export function buildSearchBody(query: string, options: WebSearchOptions = {}): URLSearchParams {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Search query is empty.");
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(`Search query is longer than ${MAX_QUERY_LENGTH} characters.`);
  }

  const body = new URLSearchParams({ q: trimmed, format: "json" });
  if (options.category) body.set("categories", options.category);
  if (options.language) body.set("language", options.language);
  if (options.timeRange) {
    if (!TIME_RANGES.has(options.timeRange)) {
      throw new Error(`timeRange must be one of ${[...TIME_RANGES].join(", ")}.`);
    }
    body.set("time_range", options.timeRange);
  }
  return body;
}

export function resultLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RESULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("limit must be a positive number.");
  }
  return Math.min(Math.floor(limit), MAX_RESULT_LIMIT);
}

// Defensive throughout: every field is optional in SearXNG's answer, engines disagree about which
// they populate, and a result missing a URL is not a result.
export function mapResults(payload: unknown, limit: number): WebSearchResult[] {
  const raw = (payload as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return [];

  const mapped: WebSearchResult[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;

    mapped.push({
      title: typeof item.title === "string" ? item.title : url,
      url,
      content: typeof item.content === "string" ? item.content : "",
      ...(typeof item.publishedDate === "string" && item.publishedDate
        ? { publishedDate: item.publishedDate }
        : {}),
      engine: typeof item.engine === "string" ? item.engine : "unknown",
    });
    if (mapped.length >= limit) break;
  }
  return mapped;
}

// Errors carry a status and nothing else. The upstream URL names an internal host, and the body can
// echo the engine's own error — which, for a key-bearing engine like Exa, is exactly where a
// credential would surface. Neither belongs in a message an agent will read back to a user.
export async function runSearch(
  fetcher: typeof fetch,
  baseUrl: string,
  query: string,
  options: WebSearchOptions = {},
): Promise<WebSearchResult[]> {
  const limit = resultLimit(options.limit);
  const body = buildSearchBody(query, options);

  let response: Response;
  try {
    response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Attaching `cause` is exactly what must not happen here: workerd's connection errors name the
    // host and port they failed to reach, this message is read back to a user by an agent, and the
    // search instance's internal address is not theirs to see. The failure mode is kept in the text.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error(
      `Web search is unavailable: the search service could not be reached (${
        error instanceof Error && error.name === "TimeoutError" ? "timed out" : "connection failed"
      }).`,
    );
  }

  if (!response.ok) {
    // 403 is what SearXNG returns when `json` is missing from `search.formats`, which is a
    // deployment mistake rather than a transient one, so it is worth naming.
    const hint = response.status === 403
      ? " The instance may not have `json` in its `search.formats`."
      : "";
    throw new Error(`Web search failed: the search service returned HTTP ${response.status}.${hint}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Web search failed: the search service returned a response that was not JSON.");
  }

  return mapResults(payload, limit);
}
