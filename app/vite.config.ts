import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5176,
    // veil-sdk is linked from ../../sdk.
    fs: { allow: ["..", "../../sdk"] },
  },
  // The linked SDK has its own starknet.js; use the app's one copy (v10, the
  // version that speaks Starknet's current RPC and the STRK20 wallet API).
  resolve: { dedupe: ["starknet"] },
  build: { target: "es2022", outDir: "dist" },
});
