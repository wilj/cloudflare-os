// Web Search: an ambient, auto-provisioned gatekeeper over this deployment's SearXNG instance.
//
// Shaped after Scheduled Tasks (`gatekeeper-scheduler`) and the Context Library: no OAuth, no
// URL-addressed resources, one singleton session per workspace, and reads only. The account is
// minted on demand rather than connected, so an agent has the binding without anyone visiting a
// connect page.
//
// Why a gatekeeper at all: the agent's own tool list is fixed in the Workshop backend, and gadget
// code cannot make network requests. A gatekeeper is the supported way for either to reach an
// outside service, and it is how every other search in this product works — Linear's
// `searchIssues`, Notion's `search`, ZoomInfo's `searchCompanies`.

import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionKind,
  AgentCatalog,
  AgentCatalogRequest,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { runSearch, type WebSearchOptions, type WebSearchResult } from "./searxng.js";
import type { WebSearchSession } from "./types.js";
import { obsContext, VENDOR_ID } from "./observability.js";
import TYPES_CODE from "./types.txt";

const logger = obsContext.createLogger({
  component: "gatekeeper.search", vendorId: VENDOR_ID,
});

// Where SearXNG listens on the container network. Overridden by the SEARXNG_URL var.
const DEFAULT_SEARXNG_URL = "http://searxng:8080";

const SEARCH_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M229.66 218.34l-50.07-50.06a88.11 88.11 0 1 0-11.31 11.31l50.06 50.07a8 8 0 0 0 " +
        "11.32-11.32ZM40 112a72 72 0 1 1 72 72 72.08 72.08 0 0 1-72-72Z'/></svg>",
    ),
};

export type SearchEnv = Cloudflare.Env & {
  // Base URL of the SearXNG instance, no trailing slash. Reached over the container network, which
  // standalone workerd permits only for workers granted private-network egress — see
  // `privateNetworkWorkers` in the deployment's generator config.
  SEARXNG_URL?: string;
};

export type SearchAccountProps = { accountId: string };

function searxngUrl(env: SearchEnv): string {
  return env.SEARXNG_URL || DEFAULT_SEARXNG_URL;
}

function describeSearchAccount(): AccountDescription {
  return {
    displayName: "Web Search",
    avatar: SEARCH_ICON,
    singleton: { tsType: "WebSearchSession" },
  };
}

// Server-controlled text is not Markdown here. A result title belongs to whoever owns the indexed
// page; left as-is it lands verbatim in the record a human reads when approving, where `](url)`
// re-points the rendered link and a long one bloats the stored action.
function plain(text: string, limit: number): string {
  return text
    .replaceAll(/[\r\n]+/g, " ")
    .replaceAll(/[[\]()`*_~|]/g, "")
    .trim()
    .slice(0, limit);
}

@validateRpc()
export class WebSearchSessionImpl extends RpcTarget implements WebSearchSession {
  constructor(
    private readonly env: SearchEnv,
    private readonly approvalQueue: NativeRpcStub<ApprovalQueue>,
  ) {
    super();
  }

  /** Searches the web through the deployment's configured engines. */
  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const trimmed = query.trim();

    // Authorized *before* the request goes out, unlike most gatekeeper reads.
    //
    // The contract permits authorizing afterwards so a description can quote the data, and that is
    // right for a read against a service that already holds it. A web search is not that: the
    // request is an outbound channel carrying agent-composed text to third-party engines, so by the
    // time a post-hoc gate ran the disclosure would already be complete. Authorizing first also
    // means a search that then fails is still recorded — otherwise a query that left the deployment
    // and errored leaves no trace at all.
    await this.approvalQueue.authorizeObservation({
      title: `Web search: ${plain(trimmed, 80)}`,
      description: `Search the web for \`${plain(trimmed, 200)}\`, through this deployment's `
        + `configured search engines.`,
    });

    let results: WebSearchResult[];
    try {
      results = await runSearch(fetch, searxngUrl(this.env), trimmed, options);
    } catch (error) {
      // The two failures this package exists to have — the instance being down, and `json` missing
      // from its `search.formats` — are otherwise visible only as a sentence an agent reads back to
      // a user, and never in the deployment's own logs.
      logger.warn("web search failed", {
        event: "search.query.failed", operation: "search", error,
      });
      throw error;
    }

    logger.info("web search completed", {
      event: "search.query.completed",
      operation: "search",
      resultCount: results.length,
      engines: [...new Set(results.map((r) => r.engine))].join(","),
    });

    return results;
  }

  // The queue stub is a duplicate this session owns; without this it is retained for the lifetime
  // of the Overseer Durable Object, and a new session is resolved on every call to the binding.
  [Symbol.dispose](): void {
    this.approvalQueue[Symbol.dispose]?.();
  }
}

// One flag per account, so `revoke()` means something.
//
// `GatekeeperUser.revoke()` promises that the user and every gatekeeper created through it become
// broken. Web Search stores nothing else, and "no state" is not the same as "no capability": a
// Gadget already wired to the binding would otherwise keep searching after the account was revoked.
// The scheduler tears down its driver for the same reason.
@validateRpc()
export class SearchAccountState extends DurableObject<SearchEnv> {
  async revoke(): Promise<void> {
    this.ctx.storage.kv.put("revoked", true);
  }

  async assertActive(): Promise<void> {
    if (this.ctx.storage.kv.get("revoked")) {
      throw new Error("Web Search has been revoked for this account.");
    }
  }
}

@validateRpc()
export class SearchGatekeeper
  extends DurableObject<SearchEnv, SearchAccountProps>
  implements Gatekeeper<WebSearchSession>
{
  /** Describes the ambient Web Search binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "search://web",
      title: "Web Search",
      snippet: "Find pages on the open web, then read them with webFetch.",
      suggestedBindingName: "WEB_SEARCH",
      tsType: "WebSearchSession",
    };
  }

  /** Returns the agent-facing WebSearchSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Reports no auto-applicable actions: this gatekeeper only reads. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  /** Opens a session for the workspace this facet was created under. */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<WebSearchSession> {
    await this.ctx.exports.SearchAccountState
      .getByName(this.ctx.props.accountId)
      .assertActive();

    const owned = approvalQueue.dup();
    try {
      return new WebSearchSessionImpl(this.env, owned);
    } catch (error) {
      // The session owns the duplicate once it exists; until then this does.
      owned[Symbol.dispose]?.();
      throw error;
    }
  }

  /** Returns no catalog: there is nothing to enumerate ahead of a query. */
  async getAgentCatalog(
    _request: AgentCatalogRequest,
    _authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    return null;
  }

  /** Accepts collaborators: results come from the public web, not from the owner's account. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** Removes a collaborator; no observer state is retained. */
  async removeObserver(_id: string): Promise<void> {}

  /** Rejects action application because Web Search is read-only. */
  applyAction(_action: number): Promise<void> {
    throw new Error("Web Search is read-only and implements no actions.");
  }

  /** Rejects action rejection because Web Search submits no actions. */
  rejectAction(_action: number): Promise<void> {
    throw new Error("Web Search is read-only and implements no actions.");
  }

  /** Rejects action reversion because Web Search submits no actions. */
  revertAction(
    _action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("Web Search is read-only and implements no actions.");
  }
}

@validateRpc()
export class SearchAccount
  extends WorkerEntrypoint<SearchEnv, SearchAccountProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned Web Search account. */
  async describe(): Promise<AccountDescription> {
    return describeSearchAccount();
  }

  /** Returns the account-imbued ambient workspace facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<WebSearchSession>>> {
    return this.ctx.exports.SearchGatekeeper({ props: this.ctx.props });
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Rejects URL resource lookup because Web Search is ambient-only. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Web Search has no URL-addressed resources.");
  }

  /** Rejects resource configuration because Web Search is ambient-only. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Web Search has no URL-addressed resources.");
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revokes the account: every session opened through it refuses from here on. */
  async revoke(): Promise<void> {
    await this.ctx.exports.SearchAccountState.getByName(this.ctx.props.accountId).revoke();
  }

  /** Rejects reconnect because Web Search holds no credentials. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("Web Search has no connect flow.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier used by the low-stakes observer policy. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SearchVerifier({});
  }
}

@validateRpc()
export class SearchVerifier
  extends WorkerEntrypoint<SearchEnv>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<SearchEnv> {
  /** Describes the connector as auto-provisioning and non-authenticating. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Web Search",
      // The engine behind this is deployment configuration; what is constant is the metasearch
      // front end the deployment runs.
      url: "https://github.com/searxng/searxng",
      logo: SEARCH_ICON,
      tagline: "Search the open web",
      description:
        "Find pages on the web through this deployment's search instance, then read them with " +
        "webFetch.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mints a new opaque Web Search account capability. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SearchAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because Web Search is auto-provisioned. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Web Search is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the complete agent-facing Web Search declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
