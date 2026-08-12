// The session, which had no tests at all: deleting the `authorizeObservation` call left the whole
// suite green.
//
// `WebSearchSessionImpl` takes its env and queue as constructor arguments and calls the global
// `fetch`, so it can be driven directly with a stub queue and a stubbed fetch — no workerd needed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchSessionImpl } from "../src/search.js";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { RpcStub } from "capnweb";

const ENV = { SEARXNG_URL: "http://searxng.invalid:8080" } as never;

function queueStub(overrides: Partial<Record<string, unknown>> = {}) {
  const authorizeObservation = vi.fn<() => Promise<void>>(async () => {});
  const dispose = vi.fn<() => void>(() => {});
  return {
    authorizeObservation,
    dispose,
    stub: {
      authorizeObservation,
      [Symbol.dispose]: dispose,
      ...overrides,
    } as unknown as RpcStub<ApprovalQueue>,
  };
}

function answerWith(results: unknown[]) {
  return vi.fn(async () => new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("WebSearchSessionImpl.search", () => {
  it("authorizes the observation before the query leaves the deployment", async () => {
    const queue = queueStub();
    const order: string[] = [];
    queue.authorizeObservation.mockImplementation(async () => { order.push("authorize"); });
    vi.stubGlobal("fetch", vi.fn(async () => {
      order.push("fetch");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));

    const session = new WebSearchSessionImpl(ENV, queue.stub);
    await session.search("polish bigos recipe");

    // The request is an outbound channel carrying agent-composed text to third parties; a gate
    // that ran afterwards would be gating a disclosure that had already happened.
    expect(order).toEqual(["authorize", "fetch"]);
  });

  it("does not search at all when the observation is refused", async () => {
    const queue = queueStub();
    queue.authorizeObservation.mockRejectedValue(new Error("denied by policy"));
    const fetchSpy = answerWith([]);
    vi.stubGlobal("fetch", fetchSpy);

    const session = new WebSearchSessionImpl(ENV, queue.stub);
    await expect(session.search("anything")).rejects.toThrow(/denied by policy/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records a search that then fails, so a query that left the box leaves a trace", async () => {
    const queue = queueStub();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));

    const session = new WebSearchSessionImpl(ENV, queue.stub);
    await expect(session.search("anything")).rejects.toThrow(/502/);
    expect(queue.authorizeObservation).toHaveBeenCalledTimes(1);
  });

  it("keeps server-controlled text out of the approval record's Markdown", async () => {
    const queue = queueStub();
    vi.stubGlobal("fetch", answerWith([]));

    const session = new WebSearchSessionImpl(ENV, queue.stub);
    await session.search("evil ](https://attacker.example) `x`\nsecond line");

    const [{ title, description }] = queue.authorizeObservation.mock.calls[0] as unknown as
        [{ title: string; description: string }];
    for (const text of [title, description]) {
      expect(text).not.toContain("](");
      expect(text).not.toContain("\n");
    }
  });

  it("releases the queue stub it owns", () => {
    const queue = queueStub();
    const session = new WebSearchSessionImpl(ENV, queue.stub);

    session[Symbol.dispose]();

    // Without this the stub is retained inside the long-lived Overseer object, and the binding
    // resolves a new session on every call.
    expect(queue.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns the mapped results", async () => {
    const queue = queueStub();
    vi.stubGlobal("fetch", answerWith([
      { url: "https://a.example", title: "A", content: "snippet", engine: "exaapi" },
    ]));

    const session = new WebSearchSessionImpl(ENV, queue.stub);
    expect(await session.search("q")).toEqual([
      { url: "https://a.example", title: "A", content: "snippet", engine: "exaapi" },
    ]);
  });
});
