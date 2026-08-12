import { WorkerEntrypoint } from "cloudflare:workers";

// Session minting for the deployment operator.
//
// Everything worth scripting after an install — admin settings, deployment-wide agent rules,
// repairing one user's account — lives behind an authenticated capnweb session on /api, and the
// only issuer of sessions is the browser sign-in flow. This entrypoint is the non-browser issuer:
// presented with the deployment's own secret it mints a session for a named account, so operator
// tooling drives the same APIs the UI drives instead of writing storage behind the app's back.
//
// It is a separate *entrypoint* rather than a path on the router because workerd binds entrypoints
// to sockets. The deployment serves this one on an internal socket that no reverse proxy routes
// to, which makes unreachability a property of the config rather than of a prefix check that a
// later refactor can quietly move.
//
// With INTERNAL_ADMIN_SECRET unset — every deployment that does not opt in — the entrypoint
// refuses everything, so a config that forgets the socket cannot expose a live minting API.

export class InternalAdmin extends WorkerEntrypoint<Cloudflare.Env> {
  async fetch(req: Request): Promise<Response> {
    let secret = this.env.INTERNAL_ADMIN_SECRET;
    if (!secret) {
      return json(404, { error: "The internal admin entrypoint is not enabled." });
    }
    if (!await presentedSecret(req, secret)) {
      return json(401, { error: "Unauthorized." });
    }
    if (req.method !== "POST") {
      return json(405, { error: "Use POST." });
    }

    let path = new URL(req.url).pathname;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "Body must be JSON." });
    }
    let { account, token } = (body ?? {}) as { account?: unknown, token?: unknown };

    // The account name is used verbatim: PublicApi.authenticate() splits the token on ":" and
    // feeds the first half straight to idFromName(), so anything normalized here would mint a
    // session on a different DO than the one the token later resolves to.
    if (typeof account !== "string" || account === "" || account.includes(":")) {
      return json(400, { error: "account must be a non-empty string containing no colon." });
    }
    let user = this.ctx.exports.UserDurableObject.getByName(account);

    switch (path) {
      case "/mint": {
        let minted = await user.mintOperatorSession();
        if (!minted) {
          return json(404, { error: `No such account: ${account}` });
        }
        return json(200, { token: `${account}:${minted}` });
      }
      case "/revoke": {
        if (typeof token !== "string" || token === "") {
          return json(400, { error: "token is required." });
        }
        // Accepts either half of the pair, so a caller can hand back exactly what /mint returned.
        let secretHalf = token.startsWith(`${account}:`)
            ? token.slice(account.length + 1)
            : token;
        await user.revokeSession(secretHalf);
        return json(200, {});
      }
      default:
        return json(404, { error: `No such endpoint: ${path}` });
    }
  }
}

// Compares digests rather than the raw strings so the loop runs over fixed-length, uniformly
// distributed bytes — the same reason login() stores a hash of the password hash.
async function presentedSecret(req: Request, expected: string): Promise<boolean> {
  let header = req.headers.get("Authorization") ?? "";
  let prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  let encoder = new TextEncoder();
  let [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice(prefix.length))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  let a = new Uint8Array(presentedHash);
  let b = new Uint8Array(expectedHash);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
