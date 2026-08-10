// Forgejo gatekeeper — sign-in only.
//
// Copied in shape from gatekeeper-github (which stays untouched) but deliberately narrower in two
// ways:
//
//  1. **No capability surface.** v1 exists to authenticate users, so getSupportedResources()
//     returns nothing and there is no Gatekeeper implementation behind it. Issues, PRs, and
//     reviews are v2 work against Forgejo's /api/v1, which is Gitea-derived and GitHub-*inspired*
//     but not compatible.
//
//  2. **No OAuth tokens are ever persisted.** Forgejo's OAuth2 access tokens are unscoped — its
//     own docs say scopes are "not yet implemented" and that a token "can be used to execute any
//     actions on behalf of the user". Sign-in only needs the identity behind the code, so the
//     token is used once to read userinfo and then dropped. This is a deliberate divergence from
//     the ported gatekeeper-github code, which stores tokens for API use.
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
  createPkcePair, discover, exchangeAuthCode, fetchClaims, type ForgejoClaims,
} from "./forgejo-oidc";
import FORGEJO_LOGO_SVG from "./forgejo-logo.svg";

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

// What the DO keeps after a completed sign-in. Note what is absent: no access token, no refresh
// token, no code verifier.
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
                       _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    // `options.scopes` is ignored: this vendor has no capability surface, so every connection is
    // an auth-only one and its grant is transient either way.
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const initiationNonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, initiationNonce);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    // No capability surface in v1. An empty list also hides the gatekeeper from the connect UI,
    // which is correct — there is nothing to connect it *to* yet.
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return "";
  }
}

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>,
                    initiationNonce: string): Promise<void> {
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
      // The token has served its only purpose. It is unscoped and can act as the user, so it is
      // never written to storage — not even transiently — and the verifier goes with it.
      this.ctx.storage.kv.delete("codeVerifier");
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

    // Sign-in grants are transient: the backend has read the identity out of complete(), so this
    // DO has nothing left to hold.
    await this.ctx.storage.setAlarm(Date.now() + EPHEMERAL_LIFETIME_MS);
    return true;
  }

  getIdentity(): StoredIdentity {
    const identity = this.ctx.storage.kv.get<StoredIdentity>("identity");
    if (!identity) {
      throw new Error("This Forgejo sign-in has expired. Please sign in again.");
    }
    return identity;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async revoke(): Promise<void> {
    // Nothing to revoke at the provider: no token was ever kept. Dropping local state is the whole
    // of it.
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
    return [];
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    throw new Error(
        `The Forgejo gatekeeper provides sign-in only and grants access to no resources (${url}).`);
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
