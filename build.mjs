/**
 * Threadlands build. Three bundles, because they run in three different worlds:
 *   main      — ESM for Node, with electron and the Agent SDK left external
 *               (the SDK spawns a CLI and resolves paths at runtime; bundling it
 *               breaks that).
 *   preload   — CJS, because a preload script cannot be an ES module. The .cjs
 *               extension is what keeps it CJS inside a "type": "module" package.
 *   renderer  — ESM for the browser.
 */
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const common = { bundle: true, sourcemap: true, logLevel: "info", target: "es2022" };

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const builds = [
  {
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main.js",
    platform: "node",
    format: "esm",
    external: ["electron", "@anthropic-ai/claude-agent-sdk"],
  },
  {
    ...common,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/preload.cjs",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/renderer.js",
    platform: "browser",
    format: "esm",
  },
];

function copyStatic() {
  cpSync("src/renderer/index.html", "dist/index.html");
  cpSync("src/assets", "dist/assets", { recursive: true }); // includes ground/ and ground.json
}

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  copyStatic();
  console.log("watching…");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStatic();
}
