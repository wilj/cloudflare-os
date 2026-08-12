import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// Runs in workerd, like the scheduler's suite. The session is an RpcTarget from
// `cloudflare:workers`, which a node environment cannot import at all — and testing a worker
// against a stand-in for its runtime is how an adjacent configuration comes to prove nothing.
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          SEARCH_GATEKEEPER: { className: "SearchGatekeeper", useSQLite: true },
          SEARCH_ACCOUNT_STATE: { className: "SearchAccountState", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
