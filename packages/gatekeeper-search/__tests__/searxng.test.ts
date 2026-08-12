import { describe, expect, it } from "vitest";
import {
  buildSearchBody,
  DEFAULT_RESULT_LIMIT,
  MAX_QUERY_LENGTH,
  MAX_RESULT_LIMIT,
  mapResults,
  resultLimit,
  runSearch,
} from "../src/searxng.js";

const BASE = "http://searxng.invalid:8080";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buildSearchBody", () => {
  it("always asks for JSON, and trims the query", () => {
    const body = buildSearchBody("  workerd facets  ");
    expect(body.get("q")).toBe("workerd facets");
    expect(body.get("format")).toBe("json");
  });

  it("passes the optional narrowing parameters under SearXNG's names", () => {
    const body = buildSearchBody("q", { category: "news", language: "en", timeRange: "week" });
    expect(body.get("categories")).toBe("news");
    expect(body.get("language")).toBe("en");
    expect(body.get("time_range")).toBe("week");
  });

  it("omits what was not asked for", () => {
    const body = buildSearchBody("q");
    expect(body.has("categories")).toBe(false);
    expect(body.has("language")).toBe(false);
    expect(body.has("time_range")).toBe(false);
  });

  it("rejects an empty query rather than searching for nothing", () => {
    expect(() => buildSearchBody("   ")).toThrow(/empty/i);
  });

  it("rejects an overlong query", () => {
    expect(() => buildSearchBody("x".repeat(MAX_QUERY_LENGTH + 1))).toThrow(/longer than/i);
  });

  it("rejects a time range SearXNG would ignore", () => {
    expect(() => buildSearchBody("q", { timeRange: "decade" as never })).toThrow(/timeRange/);
  });
});

describe("resultLimit", () => {
  it("defaults, clamps, and floors", () => {
    expect(resultLimit(undefined)).toBe(DEFAULT_RESULT_LIMIT);
    expect(resultLimit(1000)).toBe(MAX_RESULT_LIMIT);
    expect(resultLimit(3.7)).toBe(3);
  });

  it("rejects a limit that cannot mean anything", () => {
    expect(() => resultLimit(0)).toThrow(/positive/);
    expect(() => resultLimit(Number.NaN)).toThrow(/positive/);
  });
});

describe("mapResults", () => {
  const payload = {
    results: [
      { url: "https://a.example/1", title: "First", content: "snippet", engine: "exaapi",
        publishedDate: "2026-01-02T00:00:00Z" },
      { url: "https://b.example/2", engine: "duckduckgo" },
      { title: "no url, not a result", content: "x" },
      null,
      "not an object",
    ],
  };

  it("keeps only entries that have a URL", () => {
    const results = mapResults(payload, 10);
    expect(results.map((r) => r.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
  });

  it("falls back to the URL for a missing title, and to empty content", () => {
    const [, second] = mapResults(payload, 10);
    expect(second.title).toBe("https://b.example/2");
    expect(second.content).toBe("");
  });

  it("omits publishedDate rather than inventing one", () => {
    const [first, second] = mapResults(payload, 10);
    expect(first.publishedDate).toBe("2026-01-02T00:00:00Z");
    expect("publishedDate" in second).toBe(false);
  });

  it("honours the limit", () => {
    expect(mapResults(payload, 1)).toHaveLength(1);
  });

  it("treats a shapeless answer as no results, not as a crash", () => {
    expect(mapResults({}, 10)).toEqual([]);
    expect(mapResults(null, 10)).toEqual([]);
    expect(mapResults({ results: "nope" }, 10)).toEqual([]);
  });
});

describe("runSearch", () => {
  it("POSTs a form-encoded body, because SearXNG rejects GET /search by default", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ results: [{ url: "https://x.example", title: "X", engine: "exaapi" }] });
    }) as unknown as typeof fetch;

    const results = await runSearch(fetcher, `${BASE}/`, "hello");

    expect(seen?.url).toBe(`${BASE}/search`);
    expect(seen?.init.method).toBe("POST");
    expect(String(seen?.init.body)).toContain("format=json");
    expect(results).toHaveLength(1);
  });

  // The Exa API key lives in SearXNG's settings.yml, and an engine error is the obvious way for one
  // to end up in an upstream response body. Nothing from that body, and no internal hostname, may
  // reach a message the agent will read back to a user.
  it("never puts the upstream URL or body into an error", async () => {
    const fetcher = (async () =>
      new Response("exa error: invalid api key sk-secret-value", { status: 502 })) as typeof fetch;

    const error = await runSearch(fetcher, BASE, "hello").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("502");
    expect((error as Error).message).not.toContain("sk-secret-value");
    expect((error as Error).message).not.toContain("searxng.invalid");
  });

  it("names the likely cause of a 403, which is a deployment mistake", async () => {
    const fetcher = (async () => new Response("", { status: 403 })) as typeof fetch;
    const error = await runSearch(fetcher, BASE, "hello").catch((e: Error) => e);
    expect((error as Error).message).toMatch(/search\.formats/);
  });

  it("distinguishes a timeout from a refused connection", async () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const timedOut = (async () => { throw timeout; }) as typeof fetch;
    const refused = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;

    await expect(runSearch(timedOut, BASE, "q")).rejects.toThrow(/timed out/);
    await expect(runSearch(refused, BASE, "q")).rejects.toThrow(/connection failed/);
  });

  it("reports a non-JSON answer as such", async () => {
    const fetcher = (async () => new Response("<html>hi</html>", { status: 200 })) as typeof fetch;
    await expect(runSearch(fetcher, BASE, "q")).rejects.toThrow(/not JSON/);
  });
});
