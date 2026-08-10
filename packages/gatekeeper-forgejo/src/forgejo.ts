// Forgejo gatekeeper: sign-in, plus repository access.
//
// Copied in shape from gatekeeper-github, which is left untouched.
//
// **Tokens are kept only when they are needed.** Forgejo's OAuth2 access tokens are unscoped — its
// own docs say scopes are "not yet implemented" and that a token "can be used to execute any
// actions on behalf of the user" — so there is no narrower credential to ask for. A sign-in
// (`scopes: "auth"`) therefore reads the identity and drops the token without ever storing it; only
// a capability connection persists one, and that is a real escalation the branch in
// `acceptAuthCode` makes explicit. An account connected for sign-in never holds a token.
//
// Because the token is unscoped, nothing is auto-approvable: an approved write is indistinguishable
// to Forgejo from the user performing it, so the approval step is the only thing standing between
// an agent and the whole account. See forgejo-gatekeeper.ts.
//
// Identity is reported as issuer + subject rather than email. Forgejo users can change their own
// email address, so keying an account by it would let an address change silently create a second
// account and abandon the first one's workspaces.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type AuthenticatedIdentity,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  createPkcePair, discover, exchangeAuthCode, fetchClaims, refreshTokens,
  type ForgejoClaims, type TokenSet,
} from "./forgejo-oidc";
import type { ForgejoGatekeeperProps } from "./forgejo-gatekeeper";
import FORGEJO_LOGO_SVG from "./forgejo-logo.svg";
import TYPES_CODE from "./forgejo-types.txt";

export { ForgejoGatekeeperImpl } from "./forgejo-gatekeeper";

export interface Env {
  BASE_URL?: string;
  // The Forgejo instance's public origin. Must be the *public* hostname even though Forgejo runs
  // in the same compose stack: standalone workerd's global fetch() blocks private-network
  // addresses, so http://forgejo:3000 fails in a way that reads as an auth bug.
  FORGEJO_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
// How long a completed sign-in record lingers before the DO deletes itself. Long enough for the
// backend to read the identity out of complete(), short enough not to accumulate.
const EPHEMERAL_LIFETIME_MS = 2 * 60 * 1000;

// OIDC scopes. `openid` is what makes this an OIDC flow at all; profile and email populate the
// display name and the address shown in the UI. Forgejo tokens are unscoped regardless of what is
// requested here, which is exactly why none is kept.
const AUTH_SCOPES = ["openid", "profile", "email"];

// One repository resource. `grantable` is false: Forgejo issues one unscoped token for the whole
// account, so there is no narrower authorization to request per resource type, and pretending
// otherwise in the UI would misrepresent what the user is granting.
const REPO_RESOURCE = {
  urlPattern: ":forgejo/:owner/:repo",
  title: "Forgejo Repository",
  description:
      "Read files, issues, and pull requests in a Forgejo repository, and open issues or comment " +
      "with your approval.",
};

const FORGEJO_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(FORGEJO_LOGO_SVG)}`;

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Sign-in complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
  </head>
  <body style="font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #d97706; font-size: 1.5rem; margin: 0 0 1rem 0;">${title}</h1>
      <p style="color: #555; line-height: 1.6; margin: 0 0 1.5rem 0;">${message}</p>
      <button onclick="window.close()" style="padding: 0.5rem 1.5rem; background: #d97706; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer;">Close</button>
    </div>
  </body>
</html>`;
}

const INVALID_LINK_HTML = errorPage("Sign-in Link Expired",
    "This sign-in link is invalid or has expired. Please return to Cloudflare OS and try again.");
const NOT_CONFIGURED_HTML = errorPage("Forgejo Gatekeeper Not Configured",
    "This deployment has no Forgejo OAuth application configured. " +
    "Set CLIENT_ID, CLIENT_SECRET, and FORGEJO_URL on the gatekeeper.");

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/forgejo");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

function getForgejoUrl(env: Env): string {
  if (!env.FORGEJO_URL) {
    throw new Error("The Forgejo gatekeeper is not configured: FORGEJO_URL is unset.");
  }
  return stripTrailingSlashes(env.FORGEJO_URL);
}

function isConfigured(env: Env): boolean {
  return Boolean(env.CLIENT_ID && env.CLIENT_SECRET && env.FORGEJO_URL);
}

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

// What the DO keeps after a completed sign-in. For an auth-only grant this is *all* it keeps:
// no access token, no refresh token, no code verifier.
type StoredIdentity = {
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }

    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");

    // Step 1: the user opens /<doId>/<initiationNonce> and is redirected to Forgejo.
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      if (!isConfigured(env)) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const doId = path[0];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      const begun = await stub.beginOAuthFlow(path[1]);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      const endpoints = await discover(getForgejoUrl(env));
      const redirectUrl = new URL(endpoints.authorizationEndpoint);
      redirectUrl.searchParams.set("client_id", env.CLIENT_ID!);
      redirectUrl.searchParams.set("redirect_uri", `${getBaseUrl(env)}/oauth`);
      redirectUrl.searchParams.set("response_type", "code");
      redirectUrl.searchParams.set("scope", AUTH_SCOPES.join(" "));
      redirectUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);
      redirectUrl.searchParams.set("code_challenge", begun.codeChallenge);
      redirectUrl.searchParams.set("code_challenge_method", "S256");

      return Response.redirect(redirectUrl.toString(), 302);
    }

    // Step 2: Forgejo redirects back here with the authorization code.
    if (relPath === "/oauth") {
      const error = url.searchParams.get("error");
      if (error) {
        return new Response(
            "Forgejo sign-in failed. Please restart the sign-in flow from Cloudflare OS.",
            { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      const state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided", { status: 400 });
      const colonIndex = state.indexOf(":");
      if (colonIndex < 0) return new Response("Error: malformed state", { status: 400 });

      const code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided", { status: 400 });

      const stub = ctx.exports.UserAccount.get(
          ctx.exports.UserAccount.idFromString(state.slice(0, colonIndex)));
      const accepted = await stub.acceptAuthCode(code, state.slice(colonIndex + 1));
      if (!accepted) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      return new Response(SELF_CLOSING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Forgejo",
      url: this.env.FORGEJO_URL ?? "https://forgejo.org",
      logo: { url: FORGEJO_LOGO_URL },
      color: "#ffffff",
      tagline: "Sign in with your Forgejo account",
      description:
          "Sign in to Cloudflare OS with the Forgejo account on this deployment's git forge.",
      // Required for AUTH_GATEKEEPERS to honour this vendor: the backend only offers sign-in via
      // vendors that advertise it.
      providesAuth: true,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>,
                       options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // "auth" is a sign-in: the grant is transient and the token is dropped once the identity has
    // been read. Anything else is a capability connection, which has to keep the token to reach
    // the API later. Forgejo's tokens are unscoped, so that is a real escalation -- see the
    // storage note on UserAccount.
    const authOnly = options?.scopes === "auth";
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId)
        .setCallback(callback, initiationNonce, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [{ ...REPO_RESOURCE, urlPattern: `${getForgejoUrl(this.env)}/:owner/:repo` }];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>,
                    initiationNonce: string, authOnly = true): Promise<void> {
    this.ctx.storage.kv.put<boolean>("authOnly", authOnly);
    // Self-destruct if the user never finishes the flow.
    await this.ctx.storage.setAlarm(Date.now() + INITIATION_NONCE_LIFETIME_MS);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Consumes the initiation nonce and issues the OAuth nonce carried in `state`, plus a fresh PKCE
  // pair. Two nonces rather than one so the link the user clicks cannot be replayed into a token
  // exchange, and so a leaked authorization callback URL is useless on its own.
  async beginOAuthFlow(initiationNonce: string):
      Promise<{ oauthNonce: string; codeChallenge: string } | null> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "initiation" || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, initiationNonce)) {
      return null;
    }

    const oauthNonce = generateNonce();
    const { verifier, challenge } = await createPkcePair();
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    // The verifier never leaves this DO; it is deleted as soon as the exchange completes.
    this.ctx.storage.kv.put("codeVerifier", verifier);
    return { oauthNonce, codeChallenge: challenge };
  }

  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || stored.stage !== "oauth" || Date.now() >= stored.expiresAt
        || !constantTimeEqual(stored.value, oauthNonce)) {
      return false;
    }
    this.ctx.storage.kv.delete("nonce");

    if (!isConfigured(this.env)) {
      throw new Error("The Forgejo gatekeeper is not configured.");
    }
    const codeVerifier = this.ctx.storage.kv.get<string>("codeVerifier");
    if (!codeVerifier) {
      throw new Error("Sign-in took too long to complete. Please try again.");
    }

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      throw new Error("Sign-in took too long to complete. Please try again.");
    }

    const endpoints = await discover(getForgejoUrl(this.env));
    const grant = await exchangeAuthCode({
      endpoints,
      code,
      codeVerifier,
      clientId: this.env.CLIENT_ID!,
      clientSecret: this.env.CLIENT_SECRET!,
      redirectUri: `${getBaseUrl(this.env)}/oauth`,
    });

    let claims: ForgejoClaims;
    try {
      claims = await fetchClaims(endpoints, grant.accessToken);
    } finally {
      this.ctx.storage.kv.delete("codeVerifier");
    }

    // Sign-in grants keep nothing: the token is unscoped and can act as the user, so for a flow
    // that only needed an identity it is dropped here rather than stored "just in case".
    //
    // A capability connection has to keep it -- there is no narrower credential Forgejo will
    // issue. That is a real escalation and it is why this branch exists at all rather than the
    // token being stored unconditionally: an account connected for sign-in never holds one.
    if (!this.ctx.storage.kv.get<boolean>("authOnly")) {
      this.#putTokens(grant);
    }

    this.ctx.storage.kv.put<StoredIdentity>("identity", {
      issuer: endpoints.issuer,
      subject: claims.subject,
      email: claims.email,
      name: claims.name,
      username: claims.username,
      avatarUrl: claims.avatarUrl,
    });

    try {
      const props = { userObjectId: this.ctx.id.toString() };
      await callback.complete(this.ctx.exports.GatekeeperUserImpl({ props }));
    } catch (error) {
      this.ctx.storage.kv.delete("identity");
      throw error;
    }

    // A sign-in grant is transient: the backend has read the identity out of complete(), so this
    // DO has nothing left to hold. A capability connection persists instead.
    if (this.ctx.storage.kv.get<boolean>("authOnly")) {
      await this.ctx.storage.setAlarm(Date.now() + EPHEMERAL_LIFETIME_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    return true;
  }

  #putTokens(tokens: TokenSet): void {
    this.ctx.storage.kv.put("accessToken", tokens.accessToken);
    this.ctx.storage.kv.put("expiresAt", tokens.expiresAt);
    // Forgejo rotates refresh tokens, so whatever came back replaces the previous one.
    if (tokens.refreshToken) this.ctx.storage.kv.put("refreshToken", tokens.refreshToken);
    this.ctx.storage.kv.put("expiredNotified", false);
  }

  // Returns a usable access token, refreshing first when it is due. Callers should not cache the
  // result beyond a single request.
  async getAccessToken(): Promise<string> {
    const token = this.ctx.storage.kv.get<string>("accessToken");
    if (!token) {
      throw new Error("This Forgejo account is not connected for API access. Reconnect it.");
    }

    const expiresAt = this.ctx.storage.kv.get<number | null>("expiresAt");
    if (expiresAt === null || expiresAt === undefined || Date.now() < expiresAt) return token;

    const refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) return token;  // no way to refresh; let the API surface the 401

    const endpoints = await discover(getForgejoUrl(this.env));
    const refreshed = await refreshTokens({
      endpoints,
      refreshToken,
      clientId: this.env.CLIENT_ID!,
      clientSecret: this.env.CLIENT_SECRET!,
    });
    this.#putTokens(refreshed);
    return refreshed.accessToken;
  }

  async getForgejoUrl(): Promise<string> {
    return getForgejoUrl(this.env);
  }

  // Told by the gatekeeper when the API rejects our credentials, so the workshop can prompt a
  // reconnect instead of failing every call silently. Fires the callback at most once.
  async noteCredentialsExpired(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>("expiredNotified")) return;
    this.ctx.storage.kv.put("expiredNotified", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  getIdentity(): StoredIdentity {
    const identity = this.ctx.storage.kv.get<StoredIdentity>("identity");
    if (!identity) {
      throw new Error("This Forgejo sign-in has expired. Please sign in again.");
    }
    return identity;
  }

  async alarm(): Promise<void> {
    // Only ever fires for an abandoned flow or a spent sign-in grant. A capability connection has
    // no alarm set, but guard anyway: dropping its token would break the connection silently.
    if (this.ctx.storage.kv.get<string>("accessToken")) return;
    await this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    // Forgejo exposes no OAuth revocation endpoint, so dropping our copy is all that is available.
    // The grant itself remains until the user removes the application in Forgejo — worth saying
    // plainly rather than implying a revoke happened upstream.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

type GatekeeperUserImplProps = {
  userObjectId: string;
};

@validateRpc()
export class GatekeeperUserImpl extends WorkerEntrypoint<Env, GatekeeperUserImplProps>
    implements GatekeeperUser {
  #account() {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    return this.ctx.exports.UserAccount.get(id);
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().getIdentity();
    const description: AccountDescription = {
      displayName: identity.name ?? identity.username ?? identity.email ?? identity.subject,
      // AccountDescription requires an avatar. Forgejo normally supplies a `picture` claim; when
      // it does not, the vendor logo is a better placeholder than a broken image.
      avatar: { url: identity.avatarUrl ?? FORGEJO_LOGO_URL },
    };
    if (identity.username) description.uniqueName = identity.username;
    return description;
  }

  // The stable key. Preferred by the backend over getAuthenticatedEmail().
  async getAuthenticatedIdentity(): Promise<AuthenticatedIdentity | null> {
    const identity = await this.#account().getIdentity();
    return { issuer: identity.issuer, subject: identity.subject, email: identity.email };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // Kept for the interface, but it is not what this vendor is keyed by: a Forgejo user can
    // change their own address at any time.
    return (await this.#account().getIdentity()).email;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [{ ...REPO_RESOURCE, urlPattern: `${getForgejoUrl(this.env)}/:owner/:repo` }];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    const base = new URL(getForgejoUrl(this.env));
    const parsed = new URL(url);
    if (parsed.origin !== base.origin) {
      throw new Error(
          `${url} is not on this deployment's Forgejo (${base.origin}).`);
    }

    // Only /:owner/:repo. Deeper paths (/issues/1, /src/branch/main) are rejected rather than
    // silently truncated to the repository -- an agent handed a URL it did not ask for is worse
    // than an error.
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      throw new Error(
          `${url} is not a Forgejo repository URL. Expected ${base.origin}/<owner>/<repo>.`);
    }
    const [owner, repo] = segments;

    const props: ForgejoGatekeeperProps = {
      userObjectId: this.ctx.props.userObjectId,
      owner,
      // Forgejo tolerates a .git suffix in clone URLs; the API does not.
      repo: repo.replace(/\.git$/, ""),
    };
    return {
      class: this.ctx.exports.ForgejoGatekeeperImpl({ props }),
      resource: { ...REPO_RESOURCE, urlPattern: `${getForgejoUrl(this.env)}/:owner/:repo` },
    };
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    throw new Error("The Forgejo gatekeeper provides sign-in only.");
  }

  async startResourceConfigurator(resourceUrlPattern: string):
      Promise<ResourceConfiguratorFrame> {
    // Unreachable in practice: getSupportedResources() returns nothing, so the connect UI never
    // offers a resource to configure.
    throw new Error(
        `The Forgejo gatekeeper has no configurable resources (${resourceUrlPattern}).`);
  }

  async revoke(): Promise<void> {
    await this.#account().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    // Sign-in grants are transient by construction, so there is no persisted connection whose
    // credentials could expire and need restoring. Signing in again starts a fresh flow.
    throw new Error("Forgejo sign-in grants are transient; start a new sign-in instead.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    // No grantable resource types, so nothing to authorize.
    return {};
  }
}
