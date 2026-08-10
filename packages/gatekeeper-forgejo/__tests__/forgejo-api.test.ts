import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForgejoApi, ForgejoApiError } from '../src/forgejo-api';

const BASE = 'https://forge.example.com';

type Call = { url: string; method: string; body?: string; headers: Record<string, string> };

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}

const api = () => new ForgejoApi(BASE, async () => 'tok');

afterEach(() => vi.unstubAllGlobals());

describe('request shape', () => {
  it('authenticates with Forgejo\'s token scheme, not Bearer', async () => {
    // Forgejo's /api/v1 expects `Authorization: token <t>`. Bearer silently 401s.
    const calls = mockFetch(() => Response.json({ full_name: 'a/b' }));
    await api().getRepository('a', 'b');
    expect(calls[0].headers.Authorization).toBe('token tok');
    expect(calls[0].url).toBe(`${BASE}/api/v1/repos/a/b`);
  });

  it('escapes owner and repo', async () => {
    const calls = mockFetch(() => Response.json({}));
    await api().getRepository('my org', 'weird/name');
    expect(calls[0].url).toBe(`${BASE}/api/v1/repos/my%20org/weird%2Fname`);
  });

  it('keeps path separators in file paths but escapes each segment', async () => {
    // A file path is genuinely hierarchical, unlike a repo name — escaping the slashes would
    // address a file that does not exist.
    const calls = mockFetch(() => Response.json({
      type: 'file', encoding: 'base64', content: btoa('x'), sha: 's', size: 1, path: 'p',
    }));
    await api().readFile('o', 'r', 'src/deep dir/file.ts', 'main');
    expect(calls[0].url).toBe(
        `${BASE}/api/v1/repos/o/r/contents/src/deep%20dir/file.ts?ref=main`);
  });
});

describe('errors', () => {
  it('classifies 401 and 403 as auth errors, and others not', async () => {
    for (const [status, expected] of [[401, true], [403, true], [404, false], [500, false]] as const) {
      mockFetch(() => new Response('nope', { status }));
      const err = await api().getRepository('a', 'b').catch(e => e);
      expect(err).toBeInstanceOf(ForgejoApiError);
      expect(err.isAuthError).toBe(expected);
      expect(err.status).toBe(status);
    }
  });

  it('keeps a bounded slice of the response body for diagnosis', async () => {
    mockFetch(() => new Response('x'.repeat(5000), { status: 422 }));
    const err = await api().getRepository('a', 'b').catch(e => e);
    expect(err.body.length).toBe(500);
  });
});

describe('file contents', () => {
  it('decodes base64 content, including multi-byte characters', async () => {
    const text = 'const s = "héllo → 🙂";\n';
    mockFetch(() => Response.json({
      type: 'file', encoding: 'base64', path: 'a.ts', sha: 'abc', size: text.length,
      // Forgejo wraps long base64 across lines.
      content: btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/(.{20})/g, '$1\n'),
    }));
    const file = await api().readFile('o', 'r', 'a.ts');
    expect(file.text).toBe(text);
  });

  it('refuses a directory rather than returning something odd', async () => {
    mockFetch(() => Response.json({ type: 'dir', path: 'src', sha: 'x', size: 0 }));
    await expect(api().readFile('o', 'r', 'src')).rejects.toThrow(/not a file/);
  });

  it('refuses an encoding it does not understand', async () => {
    mockFetch(() => Response.json({ type: 'file', encoding: 'utf-16', content: 'x', sha: 's', size: 1, path: 'p' }));
    await expect(api().readFile('o', 'r', 'p')).rejects.toThrow(/unexpected content encoding/);
  });
});

describe('pagination', () => {
  it('stops at the requested limit rather than draining the repository', async () => {
    // An unbounded list would turn one agent tool call into hundreds of requests on a big repo.
    let pages = 0;
    mockFetch(() => {
      pages++;
      return Response.json(Array.from({ length: 50 }, (_, i) => ({ number: i })));
    });
    const issues = await api().listIssues('o', 'r', { limit: 120 });
    expect(issues.length).toBe(120);
    expect(pages).toBe(3);
  });

  it('stops early on a short page', async () => {
    let pages = 0;
    mockFetch(() => {
      pages++;
      return Response.json([{ number: 1 }, { number: 2 }]);
    });
    const issues = await api().listIssues('o', 'r', { limit: 100 });
    expect(issues.length).toBe(2);
    expect(pages).toBe(1);
  });

  it('defaults to open issues and asks only for issues, not pulls', async () => {
    // Forgejo shares one numbering space between issues and PRs; without type=issues a list of
    // "issues" silently includes pull requests.
    const calls = mockFetch(() => Response.json([]));
    await api().listIssues('o', 'r');
    const q = new URL(calls[0].url).searchParams;
    expect(q.get('state')).toBe('open');
    expect(q.get('type')).toBe('issues');
  });
});

describe('writes', () => {
  it('posts an issue body as JSON', async () => {
    const calls = mockFetch(() => Response.json({ number: 7 }));
    const issue = await api().createIssue('o', 'r', { title: 'T', body: 'B' });
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body!)).toEqual({ title: 'T', body: 'B' });
    expect(issue.number).toBe(7);
  });

  it('addresses comment deletion by comment id, not issue number', async () => {
    // The delete endpoint is /issues/comments/{id} — a global id, not scoped to the issue. Using
    // the issue number here would delete an unrelated comment.
    const calls = mockFetch(() => new Response(null, { status: 204 }));
    await api().deleteComment('o', 'r', 4242);
    expect(calls[0].url).toBe(`${BASE}/api/v1/repos/o/r/issues/comments/4242`);
    expect(calls[0].method).toBe('DELETE');
  });

  it('tolerates a 204 with no body', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(api().deleteComment('o', 'r', 1)).resolves.toBeUndefined();
  });
});

describe('tree listing', () => {
  it('requests a recursive tree and reports truncation', async () => {
    const calls = mockFetch(() => Response.json({
      tree: Array.from({ length: 3 }, (_, i) => ({ path: `f${i}`, type: 'blob', sha: 's' })),
      truncated: false, total_count: 3,
    }));
    const tree = await api().listTree('o', 'r', 'main', 10);
    expect(new URL(calls[0].url).searchParams.get('recursive')).toBe('true');
    expect(tree.entries.length).toBe(3);
    expect(tree.truncated).toBe(false);
  });

  it('reports truncation when the repo has more entries than the limit', async () => {
    // Both signals matter: Forgejo sets `truncated`, but a total_count above the limit means the
    // caller is also seeing a partial view.
    mockFetch(() => Response.json({
      tree: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, type: 'blob', sha: 's' })),
      truncated: false, total_count: 900,
    }));
    const tree = await api().listTree('o', 'r', 'main', 5);
    expect(tree.entries.length).toBe(5);
    expect(tree.truncated).toBe(true);
  });
});
