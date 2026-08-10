// The Forgejo capability surface: a repository the agent can read, and write to with approval.
//
// Reads go straight through. Writes are submitted to the ApprovalQueue and do not touch Forgejo
// until the user approves, so a write method returns before the change exists upstream — which is
// why every write sets `awaitDecision`. This gatekeeper does not simulate pending writes, so an
// agent that kept working would read a world where its action had not happened and tend to retry
// or undo itself.

import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ForgejoApi, ForgejoApiError, type ForgejoIssue } from "./forgejo-api";
import TYPES_CODE from "./forgejo-types.txt";

export type ForgejoGatekeeperProps = {
  userObjectId: string;
  owner: string;
  repo: string;
};

// A write that has been submitted for approval but not yet applied.
type StagedAction =
  | { type: "createIssue"; title: string; body: string }
  | { type: "comment"; number: number; body: string }
  | { type: "setIssueState"; number: number; state: "open" | "closed" };

type ActionRecord = {
  action: StagedAction;
  state: "pending" | "applied" | "rejected";
  // What applying produced, so revert knows what to undo.
  result?: { issueNumber?: number; commentId?: number; previousState?: "open" | "closed" };
};

export class ForgejoGatekeeperImpl
    extends DurableObject<Env, ForgejoGatekeeperProps>
    implements Gatekeeper<ForgejoRepoSession> {

  #userAccount() {
    return this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  // Every call goes through the account so a refreshed token is picked up automatically, and an
  // expired grant surfaces as "reconnect", not as an opaque 401.
  async withApi<T>(fn: (api: ForgejoApi) => Promise<T>): Promise<T> {
    const account = this.#userAccount();
    const baseUrl = await account.getForgejoUrl();
    const api = new ForgejoApi(baseUrl, () => account.getAccessToken());
    try {
      return await fn(api);
    } catch (error) {
      if (error instanceof ForgejoApiError && error.isAuthError) {
        await account.noteCredentialsExpired();
        throw new Error(
            "Forgejo credentials have expired or been revoked. Please reconnect the account.",
            { cause: error });
      }
      throw error;
    }
  }

  get owner() { return this.ctx.props.owner; }
  get repo() { return this.ctx.props.repo; }

  #nextActionId(): number {
    const value = (this.ctx.storage.kv.get<number>("counter:action") ?? 0) + 1;
    this.ctx.storage.kv.put("counter:action", value);
    return value;
  }

  #recordKey(id: number) { return `action:${id}`; }

  #record(id: number): ActionRecord {
    const record = this.ctx.storage.kv.get<ActionRecord>(this.#recordKey(id));
    if (!record) throw new Error(`Unknown Forgejo action ${id}.`);
    return record;
  }

  async submit(queue: RpcStub<ApprovalQueue>, action: StagedAction,
               description: ActionDescription): Promise<void> {
    const id = this.#nextActionId();
    this.ctx.storage.kv.put<ActionRecord>(this.#recordKey(id), { action, state: "pending" });
    try {
      await queue.submitAction(id, description);
    } catch (error) {
      // Do not leave a record behind for an action the queue never accepted.
      this.ctx.storage.kv.delete(this.#recordKey(id));
      throw error;
    }
  }

  async describe(): Promise<ResourceDescription> {
    const repo = await this.withApi(api => api.getRepository(this.owner, this.repo));
    return {
      url: repo.html_url,
      title: repo.full_name,
      snippet: repo.description || `Forgejo repository ${repo.full_name}`,
      suggestedBindingName: "FORGEJO_REPO",
      tsType: "ForgejoRepo",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    // Nothing is auto-approvable. Forgejo's OAuth tokens are unscoped, so an approved write is
    // indistinguishable to Forgejo from the user performing it; the approval step is the only
    // thing standing between an agent and the user's whole account.
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<ForgejoRepoSession> {
    return new ForgejoRepoSession(this, approvalQueue.dup());
  }

  async applyAction(id: number): Promise<void> {
    const record = this.#record(id);
    if (record.state !== "pending") throw new Error(`Forgejo action ${id} is no longer pending.`);
    const { owner, repo } = this;

    const result = await this.withApi(async (api): Promise<ActionRecord["result"]> => {
      switch (record.action.type) {
        case "createIssue": {
          const issue = await api.createIssue(owner, repo, {
            title: record.action.title, body: record.action.body,
          });
          return { issueNumber: issue.number };
        }
        case "comment": {
          const comment = await api.createComment(owner, repo,
              record.action.number, record.action.body);
          return { commentId: comment.id };
        }
        case "setIssueState": {
          // Capture the prior state first, so revert restores what was actually there rather than
          // assuming the opposite of the new value.
          const before = await api.getIssue(owner, repo, record.action.number);
          await api.setIssueState(owner, repo, record.action.number, record.action.state);
          return { previousState: before.state };
        }
      }
    });

    this.ctx.storage.kv.put<ActionRecord>(this.#recordKey(id),
        { ...record, state: "applied", result });
  }

  async rejectAction(id: number): Promise<void> {
    const record = this.#record(id);
    this.ctx.storage.kv.put<ActionRecord>(this.#recordKey(id), { ...record, state: "rejected" });
  }

  async revertAction(id: number): Promise<void> {
    const record = this.#record(id);
    if (record.state !== "applied") {
      throw new Error(`Forgejo action ${id} was never applied, so there is nothing to revert.`);
    }
    const { owner, repo } = this;

    await this.withApi(async (api) => {
      switch (record.action.type) {
        case "createIssue":
          // Forgejo cannot delete issues, so the honest revert is to close it. `implementsRevert`
          // is still true: the effect is undone as far as the API allows.
          if (record.result?.issueNumber !== undefined) {
            await api.setIssueState(owner, repo, record.result.issueNumber, "closed");
          }
          return;
        case "comment":
          if (record.result?.commentId !== undefined) {
            await api.deleteComment(owner, repo, record.result.commentId);
          }
          return;
        case "setIssueState":
          if (record.result?.previousState !== undefined) {
            await api.setIssueState(owner, repo, record.action.number, record.result.previousState);
          }
          return;
      }
    });

    this.ctx.storage.kv.put<ActionRecord>(this.#recordKey(id), { ...record, state: "rejected" });
  }

  // Observers are how the workshop shares a resource with other users. This gatekeeper grants no
  // per-observer capability, so there is nothing to track.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// What the agent actually calls. Shapes here mirror src/forgejo-types.txt, which is what the agent
// is shown — the two must stay in step.
export class ForgejoRepoSession extends RpcTarget {
  #gk: ForgejoGatekeeperImpl;
  #queue: RpcStub<ApprovalQueue>;

  constructor(gk: ForgejoGatekeeperImpl, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gk = gk;
    this.#queue = queue;
  }

  async getMetadata() {
    const repo = await this.#gk.withApi(api => api.getRepository(this.#gk.owner, this.#gk.repo));
    return {
      fullName: repo.full_name,
      description: repo.description ?? "",
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      isPrivate: repo.private,
      archived: repo.archived,
      openIssues: repo.open_issues_count ?? 0,
    };
  }

  async listFiles(options: { ref?: string; limit?: number } = {}) {
    const ref = options.ref ?? await this.#defaultBranch();
    const tree = await this.#gk.withApi(
        api => api.listTree(this.#gk.owner, this.#gk.repo, ref, options.limit ?? 500));
    return {
      entries: tree.entries.map(e => ({ path: e.path, type: e.type, size: e.size })),
      truncated: tree.truncated,
    };
  }

  async readFile(path: string, options: { ref?: string } = {}) {
    const file = await this.#gk.withApi(
        api => api.readFile(this.#gk.owner, this.#gk.repo, path, options.ref));
    return { path: file.path, text: file.text, size: file.size };
  }

  async listIssues(options: { state?: string; limit?: number; labels?: string; q?: string } = {}) {
    const issues = await this.#gk.withApi(
        api => api.listIssues(this.#gk.owner, this.#gk.repo, options));
    return issues.map(summarize);
  }

  async getIssue(number: number) {
    const [issue, comments] = await this.#gk.withApi(async api => [
      await api.getIssue(this.#gk.owner, this.#gk.repo, number),
      await api.listIssueComments(this.#gk.owner, this.#gk.repo, number),
    ] as const);
    return {
      ...summarize(issue),
      body: issue.body ?? "",
      comments: comments.map(c => ({
        author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at,
      })),
    };
  }

  async listPullRequests(options: { state?: string; limit?: number } = {}) {
    const pulls = await this.#gk.withApi(
        api => api.listPullRequests(this.#gk.owner, this.#gk.repo, options));
    return pulls.map(p => ({
      ...summarize(p), draft: Boolean(p.draft), merged: Boolean(p.merged),
    }));
  }

  async getPullRequest(number: number) {
    const [pull, comments] = await this.#gk.withApi(async api => [
      await api.getPullRequest(this.#gk.owner, this.#gk.repo, number),
      await api.listIssueComments(this.#gk.owner, this.#gk.repo, number),
    ] as const);
    return {
      ...summarize(pull),
      draft: Boolean(pull.draft),
      merged: Boolean(pull.merged),
      body: pull.body ?? "",
      comments: comments.map(c => ({
        author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at,
      })),
      headRef: pull.head?.ref ?? "",
      baseRef: pull.base?.ref ?? "",
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? 0,
    };
  }

  // --- writes ---------------------------------------------------------------------------------

  async createIssue(title: string, body: string): Promise<void> {
    await this.#gk.submit(this.#queue, { type: "createIssue", title, body }, {
      title: `Open issue "${title}" in ${this.#slug()}`,
      description: `Open a new issue in **${this.#slug()}**.\n\n### ${title}\n\n${body}`,
      implementsRevert: true,
      awaitDecision: true,
    });
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#gk.submit(this.#queue, { type: "comment", number, body }, {
      title: `Comment on #${number} in ${this.#slug()}`,
      description: `Post a comment on **${this.#slug()}#${number}**.\n\n${body}`,
      implementsRevert: true,
      awaitDecision: true,
    });
  }

  async setIssueState(number: number, state: "open" | "closed"): Promise<void> {
    await this.#gk.submit(this.#queue, { type: "setIssueState", number, state }, {
      title: `${state === "closed" ? "Close" : "Reopen"} #${number} in ${this.#slug()}`,
      description: `${state === "closed" ? "Close" : "Reopen"} issue ` +
          `**${this.#slug()}#${number}**.`,
      implementsRevert: true,
      awaitDecision: true,
    });
  }

  #slug() { return `${this.#gk.owner}/${this.#gk.repo}`; }

  async #defaultBranch(): Promise<string> {
    const repo = await this.#gk.withApi(api => api.getRepository(this.#gk.owner, this.#gk.repo));
    return repo.default_branch;
  }
}

function summarize(issue: ForgejoIssue) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    author: issue.user?.login ?? "unknown",
    labels: (issue.labels ?? []).map(l => l.name),
    commentCount: issue.comments ?? 0,
    createdAt: issue.created_at,
  };
}
