// Bundles the two Lambda handlers into one self-contained file each.
//
// Bundling rather than zipping node_modules: starknet.js, ethers and the Veil
// SDK together are ~140 MB installed, and the SDK is a `file:` dependency that
// a plain zip would not resolve. esbuild produces ~5 MB per handler instead.
//
// The AWS SDK is bundled too, not left to the runtime: which AWS SDK version a
// Lambda runtime ships is not a promise, and a keeper that cannot reach its
// state table is a keeper that stops.

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of ["tick", "intake"]) {
  await build({
    entryPoints: [join(here, "..", "src", "aws", `${name}.ts`)],
    // `.cjs`, not `.js`: this package is ESM ("type": "module"), and Lambda
    // resolves a `.cjs` handler file unambiguously as CommonJS.
    outfile: join(out, `${name}.cjs`),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: false,
    sourcemap: false,
    logLevel: "info",
  });
}

console.log(`\nbundled into ${out}`);
