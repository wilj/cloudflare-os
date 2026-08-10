// Sign-in via authentication gatekeepers.
//
// Unlike the normal connect-account flow (which runs for an already-logged-in user), login happens
// before we know who the user is. The PublicApi starts a gatekeeper connect flow (in "auth" scope
// mode) with a `LoginConnectCallbackImpl` as the callback and a `PendingLogin` DO to bridge the
// result back to the waiting browser:
//
//   1. PublicApi.startGatekeeperLogin(vendorId) creates a PendingLogin DO (keyed by a random DO id),
//      hands the gatekeeper a LoginConnectCallbackImpl, and returns {url, attempt}, where `attempt`
//      is an RpcStub wrapping the DO (so the client awaits via a capability, never a guessable id).
//   2. The browser opens `url` (the gatekeeper's self-closing OAuth popup) and calls
//      `attempt.wait()`, which blocks on the PendingLogin DO.
//   3. When the gatekeeper finishes, it calls LoginConnectCallbackImpl.complete(user). We read the
//      verified email, resolve/create the email-keyed user DO, mint a session, and deliver the token
//      to the PendingLogin DO, which resolves the awaiting RPC.
//
// Sign-in only requests minimal scopes and the gatekeeper grant is transient (it self-destructs
// shortly after we read the email) — so login does NOT create a persistent connected account.
// Capability access (repos, docs, billing) is granted later when the user explicitly connects the
// gatekeeper, which requests the full scopes and persists the connection.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  AuthenticatedIdentity, GatekeeperConnectCallback, GatekeeperUser,
} from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "../observability";
import { CLOUDFLARE_VENDOR_ID } from "../user.js";
import { readAdminConfig } from "../admin-config.js";

const logger = createWorkshopLogger("workshop.auth");

type PendingResult = { token: string } | { error: string };

// Bridges a login result from the (separate) OAuth-callback invocation back to the waiting browser.
//
// This DO holds no durable storage: a login normally completes within seconds, and the in-flight
// awaitResult() request keeps the DO alive so the in-memory waiter is reachable when deliver()/fail()
// fire. If the attempt is abandoned, the client disposes the awaiting RPC (the `attempt` stub) and
// the DO is simply evicted — no alarm or cleanup needed.
export class PendingLogin extends DurableObject<Cloudflare.Env> {
  // Awaiters from in-flight awaitResult() calls, resolved/rejected when the result arrives.
  #waiters: { resolve: (token: string) => void; reject: (err: Error) => void }[] = [];
  // Stash for the rare case deliver()/fail() arrives before awaitResult() registers a waiter.
  #result?: PendingResult;

  // Block until the login completes (or fails).
  async awaitResult(): Promise<string> {
    if (this.#result) {
      const result = this.#result;
      this.#result = undefined;  // one-time use
      if ("token" in result) return result.token;
      throw new Error(result.error);
    }
    return await new Promise<string>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  // Called by LoginConnectCallbackImpl on success: resolve the awaiter (or stash the token if none
  // is waiting yet).
  async deliver(token: string): Promise<void> {
    if (this.#waiters.length > 0) {
      for (const w of this.#waiters) w.resolve(token);
      this.#waiters = [];
    } else {
      this.#result = { token };
    }
  }

  async fail(reason: string): Promise<void> {
    if (this.#waiters.length > 0) {
      for (const w of this.#waiters) w.reject(new Error(reason));
      this.#waiters = [];
    } else {
      this.#result = { error: reason };
    }
  }
}

type LoginCallbackProps = { pendingId: string; vendorId: string };

// Derives the durable account key for an identity-providing gatekeeper.
//
// Two constraints shape this. It must be stable across profile edits — so it hashes issuer +
// subject, never the email, which users can change on providers like Forgejo — and it must contain
// no colon, because session tokens are "<doName>:<secret>" and PublicApi.authenticate() splits on
// ":" and requires exactly two parts. A raw "issuer\0subject" key would break that split outright,
// since OIDC issuers are URLs.
//
// The NUL separator keeps the pair unambiguous: without it, issuers and subjects could be
// re-partitioned to collide.
export async function deriveAccountKey(identity: AuthenticatedIdentity): Promise<string> {
  const input = new TextEncoder().encode(`${identity.issuer}\0${identity.subject}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  // base64url is colon-free by construction; padding is stripped so the key is stable.
  const base64 = btoa(String.fromCharCode(...digest));
  return `fj-${base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

// Reads the sign-in identity, preferring the stable issuer+subject form where the vendor
// implements it and falling back to the email-keyed path for vendors that do not.
async function resolveAccount(account: Fetcher<GatekeeperUser>): Promise<
    { key: string; email: string | null } | null> {
  if (typeof account.getAuthenticatedIdentity === "function") {
    const identity = await account.getAuthenticatedIdentity();
    if (identity) {
      return { key: await deriveAccountKey(identity), email: identity.email };
    }
  }
  const email = await account.getAuthenticatedEmail();
  // Legacy path: the DO name *is* the email. Keeps existing Google/GitHub/Cloudflare accounts
  // resolving to the same DO they were created under.
  return email ? { key: email, email } : null;
}

export class LoginConnectCallbackImpl
    extends WorkerEntrypoint<Cloudflare.Env, LoginCallbackProps>
    implements GatekeeperConnectCallback {
  #pending() {
    const id = this.ctx.exports.PendingLogin.idFromString(this.ctx.props.pendingId);
    return this.ctx.exports.PendingLogin.get(id);
  }

  async complete(account: Fetcher<GatekeeperUser>, expiresAt?: Date): Promise<void> {
    const loginLogger = logger.with({
      operation: "gatekeeper.login",
      vendorId: this.ctx.props.vendorId,
    });
    const pending = this.#pending();
    // `account` is a call parameter, so Cap'n Web disposes it automatically when this method
    // returns — no explicit disposal needed. We read the verified email to resolve/create the user.
    // The email's local-part seeds the initial display name, like the Cloudflare Access flow.
    try {
      const resolved = await resolveAccount(account);
      if (!resolved) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "no_email",
        });
        await pending.fail("This account has no verified email, so it can't be used to sign in.");
        return;
      }
      const { key, email } = resolved;
      const userStub = this.ctx.exports.UserDurableObject.get(
          this.ctx.exports.UserDurableObject.idFromName(key));
      // Closed signups block first-time account creation here too (not just password signup); an
      // existing user signing in is unaffected.
      const signupsEnabled = (await readAdminConfig(this.env)).signupsEnabled;
      const secret = await userStub.loginOrCreateViaGatekeeper(key, email, signupsEnabled);
      if (secret === null) {
        loginLogger.info("gatekeeper login finished", {
          event: "gatekeeper.login.finished", outcome: "signups_disabled",
        });
        await pending.fail("New sign-ups are currently disabled on this deployment.");
        return;
      }
      // For Cloudflare, signing in also links the account for AI Gateway billing: startGatekeeperLogin
      // requested full (non-transient) scopes, so persist the grant as a connected account before
      // handing back the session. Other providers use minimal, transient sign-in grants (no persist).
      if (this.ctx.props.vendorId === CLOUDFLARE_VENDOR_ID) {
        await userStub.linkConnectedAccountFromLogin(account, this.ctx.props.vendorId, expiresAt);
      }
      // Session tokens are "<doName>:<secret>"; PublicApi.authenticate() routes via idFromName of
      // the first part, so the prefix must be the DO name — the derived account key, which is
      // colon-free by construction.
      await pending.deliver(`${key}:${secret}`);
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "ok",
      });
    } catch (err) {
      loginLogger.error("gatekeeper login failed", {
        event: "gatekeeper.login.failed", error: err,
      });
      loginLogger.info("gatekeeper login finished", {
        event: "gatekeeper.login.finished", outcome: "error",
      });
      await pending.fail("Sign-in failed. Please try again.");
    }
  }

  // No-ops: for transient sign-in grants there's nothing persisted to update. For the Cloudflare
  // billing connection (persisted on login) these would ideally flip the account's credential flag,
  // but the callback doesn't carry the user/account identity (it's only learned in complete()). The
  // billing path degrades gracefully regardless — getUsableAccessToken() returns null on expiry and
  // the user falls back to the free tier / a reconnect prompt.
  async credentialsExpired(): Promise<void> {}
  async credentialsRestored(_expiresAt?: Date): Promise<void> {}
}
