// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

export interface Env {
  WORKSHOP_BACKEND: Fetcher;
  // Present in production (wrangler.jsonc assets stanza); absent in dev.
  ASSETS?: Fetcher;
  // Dormant until custom domains + Email Routing exist; the handler ships anyway.
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint>;
  [key: string]: unknown;
}

// Extension → Content-Type. Needed only for the standalone deployment: workerd's `disk` service
// is deliberately bare and labels every file `application/octet-stream`, which browsers hard-refuse
// for ES modules and stylesheets. Its own docs say to wrap it in a Worker that fills in the
// metadata. Cloudflare's `assets` binding does this natively, so on a normal deploy the map just
// restates what the platform already sent.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

// The extension of the last path segment, or "" when it has none.
function extensionOf(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  return dot > slash ? pathname.slice(dot).toLowerCase() : "";
}

function withContentType(res: Response, ext: string, status?: number): Response {
  const type = CONTENT_TYPES[ext];
  if (!type && status === undefined) return res;
  const headers = new Headers(res.headers);
  if (type) headers.set("content-type", type);
  return new Response(res.body, { status: status ?? res.status, headers });
}

function serveIndex(assets: Fetcher, url: URL): Promise<Response> {
  // The SPA fallback answers 200, not the underlying status: the route exists, it is just
  // resolved client-side.
  return assets.fetch(new Request(new URL("/index.html", url)))
      .then((res) => withContentType(res, ".html", 200));
}

// Implements `not_found_handling: "single-page-application"` on top of a bare file server.
async function serveAssets(assets: Fetcher, req: Request, url: URL): Promise<Response> {
  const isNavigation = req.method === "GET"
      && (req.headers.get("accept") ?? "").includes("text/html");
  const ext = extensionOf(url.pathname);

  // A path with no file extension is a client-side route, and `/` is a directory -- which a bare
  // file server answers with a JSON listing rather than index.html. Neither is worth asking about.
  if (ext === "" && isNavigation) return serveIndex(assets, url);

  const res = await assets.fetch(req);
  if (res.ok) return withContentType(res, ext);

  // Missing sub-resources keep their 404, so a broken script tag stays visible instead of being
  // silently answered with HTML.
  return isNavigation ? serveIndex(assets, url) : res;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      return serveAssets(env.ASSETS, req, url);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    return env.WORKSHOP_BACKEND.fetch(req);
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await env.GATEKEEPER_EMAIL.email(message);
  },
} satisfies ExportedHandler<Env>;
