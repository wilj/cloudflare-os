// Forgejo's OpenID Connect provider surface.
//
// Forgejo is an OIDC provider as well as a git forge: authorization-code grant with PKCE, plus
// discovery. Endpoints (all confirmed against a live instance):
//
//   /.well-known/openid-configuration   discovery
//   /login/oauth/authorize              authorization
//   /login/oauth/access_token           token exchange
//   /login/oauth/userinfo               claims
//   /login/oauth/keys                   JWKS
//
// Endpoints are read from discovery rather than hardcoded, so a Forgejo that moves them (or sits
// under a path prefix) keeps working; the well-known path itself is the only fixed assumption.

export type OidcEndpoints = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
};

export type ForgejoClaims = {
  subject: string;
  email: string | null;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
};

export class ForgejoOidcError extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ForgejoOidcError(`Forgejo OIDC discovery is missing "${field}".`);
  }
  return value;
}

export async function discover(baseUrl: string): Promise<OidcEndpoints> {
  const url = `${baseUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ForgejoOidcError(
        `Forgejo OIDC discovery failed (${res.status}). Checked ${url}.`);
  }
  const doc = await res.json() as Record<string, unknown>;
  return {
    issuer: requireString(doc.issuer, "issuer"),
    authorizationEndpoint: requireString(doc.authorization_endpoint, "authorization_endpoint"),
    tokenEndpoint: requireString(doc.token_endpoint, "token_endpoint"),
    userinfoEndpoint: requireString(doc.userinfo_endpoint, "userinfo_endpoint"),
  };
}

// PKCE. Forgejo supports S256, and using it means an intercepted authorization code is useless
// without the verifier.
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Exchanges the authorization code for a token set.
//
// The access token is returned so the caller can read the userinfo endpoint with it, and then
// discarded — see the note in forgejo.ts. Forgejo's OAuth2 tokens are unscoped and can act as the
// user, so v1 never persists one.
export async function exchangeAuthCode(options: {
  endpoints: OidcEndpoints;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string; idToken: string | null }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code_verifier: options.codeVerifier,
  });

  const res = await fetch(options.endpoints.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) {
    throw new ForgejoOidcError(
        `Forgejo rejected the authorization code (${res.status}). ` +
        `Check that the OAuth application's redirect URI is exactly ${options.redirectUri}.`);
  }

  const json = await res.json() as Record<string, unknown>;
  const accessToken = json.access_token;
  if (typeof accessToken !== "string") {
    throw new ForgejoOidcError("Forgejo's token response contained no access_token.");
  }
  return {
    accessToken,
    idToken: typeof json.id_token === "string" ? json.id_token : null,
  };
}

// Reads the identity claims.
//
// The id_token is not verified here, and is not used as the source of truth: userinfo is fetched
// directly from the issuer over TLS with the freshly-minted access token, which is a stronger
// guarantee than validating a JWT we just received from that same endpoint. `sub` is taken from
// userinfo for the same reason.
export async function fetchClaims(
    endpoints: OidcEndpoints, accessToken: string): Promise<ForgejoClaims> {
  const res = await fetch(endpoints.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new ForgejoOidcError(`Forgejo userinfo request failed (${res.status}).`);
  }
  const claims = await res.json() as Record<string, unknown>;

  const subject = claims.sub;
  if (typeof subject !== "string" && typeof subject !== "number") {
    throw new ForgejoOidcError("Forgejo userinfo contained no 'sub' claim.");
  }

  return {
    // Forgejo's `sub` is the numeric user id; normalise to a string so the derived account key is
    // stable regardless of how it is encoded.
    subject: String(subject),
    email: typeof claims.email === "string" && claims.email !== "" ? claims.email : null,
    name: typeof claims.name === "string" && claims.name !== "" ? claims.name : null,
    username: typeof claims.preferred_username === "string" && claims.preferred_username !== ""
        ? claims.preferred_username : null,
    avatarUrl: typeof claims.picture === "string" && claims.picture !== "" ? claims.picture : null,
  };
}
