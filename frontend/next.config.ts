import type { NextConfig } from "next";

// Turbopack watches files through the operating system. Docker Desktop does not
// deliver a Windows bind-mount event into a Linux container, so the dev server
// never sees a code change there. A poll interval fixes it. No environment
// variable reaches the watcher, so the value has to come through this file.
// Leave TM_WATCH_POLL_MS unset outside a container: polling then costs nothing.
const pollIntervalMs = Number(process.env.TM_WATCH_POLL_MS) || 0;

const nextConfig: NextConfig = {
  ...(pollIntervalMs > 0 ? { watchOptions: { pollIntervalMs } } : {}),
  /* Allow overriding the build/dist directory so a parallel process (e.g. Playwright's
     `npm run build && npm run start`) can run without stepping on the user's live dev
     server's `.next` dir lock. Defaults to `.next` when the env var is not set. */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    const backendUrl = process.env.TM_BE_URL;
    if (!backendUrl) {
      // No backend configured: built-in mock route handlers serve /api/v1.
      return [];
    }
    return {
      // beforeFiles so the rewrite wins over the filesystem route handlers in app/api/v1.
      beforeFiles: [
        {
          source: "/api/v1/:path*",
          destination: `${backendUrl}/api/v1/:path*`,
        },
        // The API's own Swagger page, on this origin. The sidebar links to it.
        // `TM_BE_URL` names an in-cluster service, so a browser cannot open it
        // and the deployment publishes no public API address the page could
        // read. These three carry the page through this origin instead.
        // `/docs` asks for `/openapi.json` by that exact path, so both move
        // together or the page loads empty. All three are open on the API and
        // need no token (`api/api/main.py:540`).
        { source: "/docs", destination: `${backendUrl}/docs` },
        { source: "/redoc", destination: `${backendUrl}/redoc` },
        { source: "/openapi.json", destination: `${backendUrl}/openapi.json` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
