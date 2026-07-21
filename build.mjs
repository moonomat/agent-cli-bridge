// Bundle the bridge to a single self-contained JS file (dist/agent-cli-bridge.mjs)
// plus the MCP proxy (spawned as a subprocess, so copied — not bundled).
// These two files are the entire runtime artifact GitHub Releases distributes;
// deliberately NOT minified so users can read what the install script fetched.
import { build } from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf-8"));

await mkdir(new URL("./dist", import.meta.url), { recursive: true });

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/agent-cli-bridge.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: false,
  define: { __BRIDGE_VERSION__: JSON.stringify(pkg.version) },
  // CJS deps (cross-spawn) use require() of node builtins; give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

await copyFile("src/bridge/mcp-proxy-server.cjs", "dist/mcp-proxy-server.cjs");
console.log("dist/mcp-proxy-server.cjs copied");
