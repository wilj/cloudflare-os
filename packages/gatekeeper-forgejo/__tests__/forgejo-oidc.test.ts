import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ForgejoOidcError, createPkcePair, discover, exchangeAuthCode, fetchClaims,
} from '../src/forgejo-oidc';

const BASE = 'https://forge.example.com';

const ENDPOINTS = {
  issuer: BASE,
  authorizationEndpoint: `${BASE}/login/oauth/authorize`,
  tokenEndpoint: `${BASE}/login/oauth/access_token`,
  userinfoEndpoint: `${BASE}/login/oauth/userinfo`,
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init)));
}

afterEach(() => vi.unstubAllGlobals());

describe('discovery', () => {
  it('reads the endpoints from the well-known document', async () => {
    // Endpoints come from discovery rather than being hardcoded, so a Forgejo behind a path prefix
    // keeps working.
    mockFetch((url) => {
      expect(url).toBe(`${BASE}/.well-known/openid-configuration`);
      return Response.json({
        issuer: BASE,
        authorization_endpoint: `${BASE}/login/oauth/authorize`,
        token_endpoint: `${BASE}/login/oauth/access_token`,
        userinfo_endpoint: `${BASE}/login/oauth/userinfo`,
      });
    });
    await expect(discover(BASE)).resolves.toEqual(ENDPOINTS);
  });

  it('tolerates a trailing slash on the configured URL', async () => {
    mockFetch((url) => {
      expect(url).toBe(`${BASE}/.well-known/openid-configuration`);
      return Response.json({
        issuer: BASE,
        authorization_endpoint: 'a',
        token_endpoint: 't',
        userinfo_endpoint: 'u',
      });
    });
    await expect(discover(`${BASE}/`)).resolves.toMatchObject({ issuer: BASE });
  });

  it('fails loudly when discovery is unreachable or incomplete', async () => {
    mockFetch(() => new Response('nope', { status: 404 }));
    await expect(discover(BASE)).rejects.toBeInstanceOf(ForgejoOidcError);

    mockFetch(() => Response.json({ issuer: BASE }));
    await expect(discover(BASE)).rejects.toThrow(/authorization_endpoint/);
  });
});

describe('PKCE', () => {
  it('derives an S256 challenge from a fresh verifier each time', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    // base64url: no padding, no characters that would need escaping in a query string.
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.challenge).not.toContain('=');
    expect(a.challenge).not.toBe(a.verifier);
  });

  it('produces a challenge that is the SHA-256 of the verifier', async () => {
    const { verifier, challenge } = await createPkcePair();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    expect(challenge).toBe(expected);
  });
});

describe('token exchange', () => {
  it('posts the code with its verifier and returns the tokens', async () => {
    let body: URLSearchParams | undefined;
    mockFetch((url, init) => {
      expect(url).toBe(ENDPOINTS.tokenEndpoint);
      body = new URLSearchParams(init!.body as string);
      return Response.json({ access_token: 'tok', id_token: 'jwt' });
    });

    const result = await exchangeAuthCode({
      endpoints: ENDPOINTS, code: 'the-code', codeVerifier: 'the-verifier',
      clientId: 'cid', clientSecret: 'secret',
      redirectUri: 'https://agents.example.com/gatekeeper/forgejo/oauth',
    });

    expect(result).toEqual({ accessToken: 'tok', idToken: 'jwt' });
    expect(body?.get('grant_type')).toBe('authorization_code');
    expect(body?.get('code')).toBe('the-code');
    // Without the verifier the exchange is not PKCE-protected at all.
    expect(body?.get('code_verifier')).toBe('the-verifier');
    expect(body?.get('redirect_uri'))
        .toBe('https://agents.example.com/gatekeeper/forgejo/oauth');
  });

  it('explains the most likely cause when Forgejo rejects the code', async () => {
    // A redirect-URI mismatch is by far the common failure here, and the raw 400 says nothing.
    mockFetch(() => new Response('bad', { status: 400 }));
    await expect(exchangeAuthCode({
      endpoints: ENDPOINTS, code: 'c', codeVerifier: 'v', clientId: 'i', clientSecret: 's',
      redirectUri: 'https://agents.example.com/gatekeeper/forgejo/oauth',
    })).rejects.toThrow(/redirect URI is exactly https:\/\/agents\.example\.com/);
  });

  it('rejects a token response with no access_token', async () => {
    mockFetch(() => Response.json({ token_type: 'bearer' }));
    await expect(exchangeAuthCode({
      endpoints: ENDPOINTS, code: 'c', codeVerifier: 'v', clientId: 'i', clientSecret: 's',
      redirectUri: 'r',
    })).rejects.toThrow(/no access_token/);
  });
});

describe('claims', () => {
  it('reads userinfo with the bearer token', async () => {
    mockFetch((url, init) => {
      expect(url).toBe(ENDPOINTS.userinfoEndpoint);
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return Response.json({
        sub: 3, name: 'Wil', preferred_username: 'wil',
        email: 'wil@example.com', picture: 'https://forge.example.com/avatar/3',
      });
    });

    await expect(fetchClaims(ENDPOINTS, 'tok')).resolves.toEqual({
      // Forgejo sends `sub` as a number; it is normalised so the derived account key does not
      // depend on how it happened to be encoded.
      subject: '3',
      name: 'Wil',
      username: 'wil',
      email: 'wil@example.com',
      avatarUrl: 'https://forge.example.com/avatar/3',
    });
  });

  it('treats absent and empty optional claims alike', async () => {
    mockFetch(() => Response.json({ sub: '7', email: '', name: '' }));
    await expect(fetchClaims(ENDPOINTS, 'tok')).resolves.toEqual({
      subject: '7', email: null, name: null, username: null, avatarUrl: null,
    });
  });

  it('refuses a userinfo response with no subject', async () => {
    // Without `sub` there is no stable identity, and falling back to email would reintroduce
    // exactly the mutable key this gatekeeper exists to avoid.
    mockFetch(() => Response.json({ email: 'wil@example.com' }));
    await expect(fetchClaims(ENDPOINTS, 'tok')).rejects.toThrow(/no 'sub' claim/);
  });

  it('surfaces a failed userinfo request', async () => {
    mockFetch(() => new Response('denied', { status: 401 }));
    await expect(fetchClaims(ENDPOINTS, 'tok')).rejects.toBeInstanceOf(ForgejoOidcError);
  });
});
