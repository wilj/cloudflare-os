// Forgejo REST client, `/api/v1`.
//
// Forgejo's API is Gitea-derived and GitHub-*inspired* but not compatible: issue numbers are
// `number` (GitHub's `number`) while `id` is a global row id, pagination is `page`/`limit` with a
// `Link` header, and there is no GraphQL. Shapes here were taken from this deployment's own
// `/swagger.v1.json` rather than from documentation, as the plan requires.

export type ForgejoUser = {
  login: string;
  full_name?: string;
  avatar_url?: string;
};

export type ForgejoIssue = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: ForgejoUser;
  labels?: { name: string }[];
  comments: number;
  // Present (non-null) when the issue is really a pull request. Forgejo, like Gitea, keeps both in
  // one numbering space, so this is the only reliable discriminator.
  pull_request?: unknown | null;
};

export type ForgejoComment = {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user?: ForgejoUser;
};

export type ForgejoPullRequest = ForgejoIssue & {
  head?: { ref: string; sha: string };
  base?: { ref: string; sha: string };
  mergeable?: boolean;
  merged?: boolean;
  draft?: boolean;
  additions?: number;
  deletions?: number;
  changed_files?: number;
};

export type ForgejoRepository = {
  full_name: string;
  description: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  stars_count?: number;
  open_issues_count?: number;
};

export type ForgejoTreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
};

export class ForgejoApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: string) {
    super(message);
  }

  // 401 means the token is gone or revoked; 403 can mean the same for an unscoped token whose
  // grant was withdrawn. Both should push the user through reconnect rather than look like a bug.
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class ForgejoApi {
  #baseUrl: string;
  #token: () => Promise<string>;

  constructor(baseUrl: string, token: () => Promise<string>) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#token = token;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.#baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${await this.#token()}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ForgejoApiError(res.status,
          `Forgejo ${method} ${path} failed (${res.status})`, text.slice(0, 500));
    }
    if (res.status === 204) return undefined as T;
    return await res.json() as T;
  }

  // Pagination is page/limit. Callers ask for a bounded number of items rather than "all", so a
  // large repository cannot turn one agent tool call into hundreds of requests.
  async #paged<T>(path: string, limit: number, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    const perPage = Math.min(limit, 50);
    for (let page = 1; out.length < limit; page++) {
      const params = new URLSearchParams({ ...query, page: String(page), limit: String(perPage) });
      const batch = await this.#request<T[]>("GET", `${path}?${params}`);
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out.slice(0, limit);
  }

  getRepository(owner: string, repo: string): Promise<ForgejoRepository> {
    return this.#request("GET", `/repos/${enc(owner)}/${enc(repo)}`);
  }

  listIssues(owner: string, repo: string,
             options: { state?: string; limit?: number; labels?: string; q?: string } = {}) {
    const query: Record<string, string> = { state: options.state ?? "open", type: "issues" };
    if (options.labels) query.labels = options.labels;
    if (options.q) query.q = options.q;
    return this.#paged<ForgejoIssue>(
        `/repos/${enc(owner)}/${enc(repo)}/issues`, options.limit ?? 30, query);
  }

  getIssue(owner: string, repo: string, index: number): Promise<ForgejoIssue> {
    return this.#request("GET", `/repos/${enc(owner)}/${enc(repo)}/issues/${index}`);
  }

  listIssueComments(owner: string, repo: string, index: number, limit = 50) {
    return this.#paged<ForgejoComment>(
        `/repos/${enc(owner)}/${enc(repo)}/issues/${index}/comments`, limit);
  }

  listPullRequests(owner: string, repo: string, options: { state?: string; limit?: number } = {}) {
    return this.#paged<ForgejoPullRequest>(
        `/repos/${enc(owner)}/${enc(repo)}/pulls`, options.limit ?? 30,
        { state: options.state ?? "open" });
  }

  getPullRequest(owner: string, repo: string, index: number): Promise<ForgejoPullRequest> {
    return this.#request("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${index}`);
  }

  // File contents. Forgejo returns base64 in `content` for blobs.
  async readFile(owner: string, repo: string, path: string, ref?: string):
      Promise<{ path: string; text: string; sha: string; size: number }> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const res = await this.#request<{
      content?: string; encoding?: string; sha: string; size: number; path: string; type: string;
    }>("GET", `/repos/${enc(owner)}/${enc(repo)}/contents/${encodePath(path)}${query}`);

    if (res.type !== "file" || res.content === undefined) {
      throw new ForgejoApiError(400, `${path} is not a file`);
    }
    if (res.encoding !== "base64") {
      throw new ForgejoApiError(500, `unexpected content encoding: ${res.encoding}`);
    }
    return { path: res.path, sha: res.sha, size: res.size, text: decodeBase64(res.content) };
  }

  // Recursive tree listing, used for "what is in this repo".
  async listTree(owner: string, repo: string, ref: string, limit = 500):
      Promise<{ entries: ForgejoTreeEntry[]; truncated: boolean }> {
    const params = new URLSearchParams({ recursive: "true", page: "1", per_page: String(limit) });
    const res = await this.#request<{
      tree: ForgejoTreeEntry[]; truncated: boolean; total_count: number;
    }>("GET", `/repos/${enc(owner)}/${enc(repo)}/git/trees/${encodeURIComponent(ref)}?${params}`);
    return {
      entries: (res.tree ?? []).slice(0, limit),
      truncated: Boolean(res.truncated) || (res.total_count ?? 0) > limit,
    };
  }

  createIssue(owner: string, repo: string, options: { title: string; body?: string; labels?: number[] }) {
    return this.#request<ForgejoIssue>(
        "POST", `/repos/${enc(owner)}/${enc(repo)}/issues`, options);
  }

  createComment(owner: string, repo: string, index: number, body: string) {
    return this.#request<ForgejoComment>(
        "POST", `/repos/${enc(owner)}/${enc(repo)}/issues/${index}/comments`, { body });
  }

  deleteComment(owner: string, repo: string, id: number): Promise<void> {
    return this.#request("DELETE", `/repos/${enc(owner)}/${enc(repo)}/issues/comments/${id}`);
  }

  setIssueState(owner: string, repo: string, index: number, state: "open" | "closed") {
    return this.#request<ForgejoIssue>(
        "PATCH", `/repos/${enc(owner)}/${enc(repo)}/issues/${index}`, { state });
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

// Paths keep their separators; each segment is escaped individually.
function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function decodeBase64(value: string): string {
  const binary = atob(value.replaceAll("\n", ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
