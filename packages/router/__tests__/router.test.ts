import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import router, { type Env } from '../src/index';
// Imported as text so the config-integrity tests run inside workerd without filesystem access.
import wranglerConfigText from '../wrangler.jsonc?raw';

function stubFetcher(label: string): Fetcher {
  return {
    fetch: async () => new Response(label),
  } as unknown as Fetcher;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    WORKSHOP_BACKEND: stubFetcher('backend'),
    ...extra,
  } as Env;
}

async function route(env: Env, path: string): Promise<string> {
  const req = new Request(`https://example.com${path}`);
  const res = await router.fetch!(req, env, {} as ExecutionContext);
  return res.text();
}

describe('router fetch', () => {
  it('routes /api and /blueprint-screenshot prefixes to the backend', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/api/workshop')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('backend');
  });

  it('does not treat /api-lookalike paths as backend routes', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/apiary')).toBe('assets');
    expect(await route(env, '/blueprint-screenshots')).toBe('assets');
  });

  it('routes /gatekeeper/<short> by scanning GATEKEEPER_* bindings', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
      GATEKEEPER_HOMEASSISTANT: stubFetcher('homeassistant'),
    });
    expect(await route(env, '/gatekeeper/google')).toBe('google');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/gatekeeper/homeassistant/foo')).toBe('homeassistant');
  });

  it('maps underscores in binding names to dashes in the path', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_MY_SERVICE: stubFetcher('my-service'),
    });
    expect(await route(env, '/gatekeeper/my-service')).toBe('my-service');
    expect(await route(env, '/gatekeeper/my-service/oauth')).toBe('my-service');
  });

  it('does not match gatekeeper prefixes on longer path segments', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/gatekeeper/googles')).toBe('assets');
  });

  it('serves everything else from ASSETS when the binding is present', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/')).toBe('assets');
    expect(await route(env, '/blueprints/123')).toBe('assets');
    expect(await route(env, '/gatekeeper/not-installed')).toBe('assets');
  });

  // Dev has no ASSETS binding: the backend serves the frontend from its own assets binding in
  // `run-local` mode, and in normal dev mode you open the Vite server on :3000 directly.
  it('falls through to the backend when ASSETS is absent', async () => {
    const env = makeEnv();
    expect(await route(env, '/')).toBe('backend');
    expect(await route(env, '/blueprints/123')).toBe('backend');
  });
});

// Standalone workerd has no `assets` binding. A `disk` service serves the built frontend instead,
// and it is deliberately bare: every file comes back as application/octet-stream, a directory
// comes back as a JSON listing rather than index.html, and nothing is missing-file aware. This
// stub reproduces those three behaviours so the wrapper is tested against what it actually faces.
function diskFetcher(files: Record<string, string>): Fetcher {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === 'string' ? input : (input as Request).url ?? input)
          .pathname;
      if (files[path] !== undefined) {
        return new Response(files[path], {
          headers: { 'content-type': 'application/octet-stream', 'content-length': '1' },
        });
      }
      if (path === '/') {
        return new Response('[{"name":"index.html","type":"file"}]', {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  } as unknown as Fetcher;
}

const DIST = {
  '/index.html': '<!doctype html><title>app</title>',
  '/assets/app.js': 'export default 1',
  '/assets/app.css': 'body{}',
  '/favicon.svg': '<svg/>',
};

async function get(env: Env, path: string, headers: Record<string, string> = {}) {
  return router.fetch!(new Request(`https://example.com${path}`, { headers }), env,
      {} as ExecutionContext);
}

const NAV = { accept: 'text/html,application/xhtml+xml' };

describe('static assets on a bare file server', () => {
  const env = () => makeEnv({ ASSETS: diskFetcher(DIST) });

  it('labels assets with a usable Content-Type', async () => {
    // The whole point: browsers hard-refuse ES modules and stylesheets served as
    // application/octet-stream, which is all a disk service ever sends.
    expect((await get(env(), '/assets/app.js')).headers.get('content-type'))
        .toBe('text/javascript; charset=utf-8');
    expect((await get(env(), '/assets/app.css')).headers.get('content-type'))
        .toBe('text/css; charset=utf-8');
    expect((await get(env(), '/favicon.svg')).headers.get('content-type'))
        .toBe('image/svg+xml');
  });

  it('serves index.html at / instead of a directory listing', async () => {
    const res = await get(env(), '/', NAV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('falls back to index.html for client-side routes', async () => {
    for (const path of ['/workspaces', '/blueprint/123', '/deep/nested/route']) {
      const res = await get(env(), path, NAV);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<!doctype html>');
    }
  });

  it('falls back for a navigation to a missing path that looks like a file', async () => {
    const res = await get(env(), '/report.2026', NAV);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('keeps 404s for missing sub-resources', async () => {
    // A broken script tag must stay visible rather than being answered with HTML, which would
    // surface as a confusing syntax error instead of a missing file.
    expect((await get(env(), '/assets/missing.js')).status).toBe(404);
    expect((await get(env(), '/assets/missing.css')).status).toBe(404);
  });

  it('passes real files through untouched, including their body', async () => {
    const res = await get(env(), '/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('export default 1');
  });
});

describe('router email', () => {
  it('forwards to GATEKEEPER_EMAIL when bound', async () => {
    const received: unknown[] = [];
    const env = makeEnv({
      GATEKEEPER_EMAIL: { email: async (m: unknown) => { received.push(m); } },
    });
    const message = {} as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(received).toEqual([message]);
  });

  it('rejects mail when no email gatekeeper is installed', async () => {
    const rejections: string[] = [];
    const env = makeEnv();
    const message = {
      setReject: (reason: string) => { rejections.push(reason); },
    } as unknown as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(rejections).toHaveLength(1);
  });
});

// The deploy service renders customer instances from this config (via the release manifest), so
// the asset-routing contract must hold: worker-first prefixes cover every dynamic route, or asset
// 404 handling would swallow API and gatekeeper traffic.
describe('wrangler.jsonc contract', () => {
  const config = parse(wranglerConfigText);

  it('runs the worker first for API, screenshot, and gatekeeper prefixes', () => {
    const first: string[] = config.assets.run_worker_first;
    expect(first).toContain('/api');
    expect(first).toContain('/api/*');
    expect(first).toContain('/blueprint-screenshot');
    expect(first).toContain('/blueprint-screenshot/*');
    expect(first).toContain('/gatekeeper/*');
  });

  it('serves the frontend as a single-page application', () => {
    expect(config.assets.not_found_handling).toBe('single-page-application');
    expect(config.assets.directory).toBe('../workshop-frontend/dist');
    expect(config.assets.binding).toBe('ASSETS');
  });

  it('binds the workshop backend', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKSHOP_BACKEND',
      service: 'workshop-backend',
    });
  });
});

describe('directory listings are never served', () => {
  // A bare file server answers a directory with a JSON listing. Serving that would publish the
  // contents of the asset directory to anyone who asks, so extension-less paths always resolve to
  // index.html regardless of what the client says it accepts.
  it('serves index.html at / even without an Accept header', async () => {
    const env = makeEnv({ ASSETS: diskFetcher(DIST) });
    const res = await get(env, '/');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<!doctype html>');
  });
});

describe('a missing asset directory is not disguised as success', () => {
  // Regression: forcing the SPA fallback to 200 turned a detached asset directory into a 200
  // whose body was the string "Not Found". Every health signal stayed green while the app served
  // a blank page.
  const empty = () => makeEnv({ ASSETS: diskFetcher({}) });

  it('propagates the failure for an extension-less path', async () => {
    const res = await get(empty(), '/workspaces', NAV);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<!doctype html>');
  });

  it('propagates the failure at the root', async () => {
    expect((await get(empty(), '/', NAV)).status).toBe(404);
  });

  it('still serves index.html normally when it is present', async () => {
    const res = await get(makeEnv({ ASSETS: diskFetcher(DIST) }), '/workspaces', NAV);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
  });
});
