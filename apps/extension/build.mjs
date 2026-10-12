import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/**
 * MV3 forbids remote code, so everything is bundled. The content script runs
 * as a classic script (no import support in content-script context), while the
 * service worker is a module per the manifest.
 */
const common = {
  bundle: true,
  target: ["chrome120"],
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
};

const builds = [
  { ...common, entryPoints: ["src/content/main.ts"], outfile: `${outdir}/content/main.js`, format: "iife" },
  { ...common, entryPoints: ["src/background/worker.ts"], outfile: `${outdir}/background/worker.js`, format: "esm" },
  { ...common, entryPoints: ["src/sidepanel/panel.ts"], outfile: `${outdir}/sidepanel/panel.js`, format: "iife" },
];

async function copyStatic() {
  await cp("manifest.json", `${outdir}/manifest.json`);
  await mkdir(`${outdir}/sidepanel`, { recursive: true });
  await cp("src/sidepanel/panel.html", `${outdir}/sidepanel/panel.html`);
  await cp("src/sidepanel/panel.css", `${outdir}/sidepanel/panel.css`);
}

if (watch) {
  for (const cfg of builds) (await context(cfg)).watch();
  await copyStatic();
  console.log("watching…");
} else {
  await Promise.all(builds.map(build));
  await copyStatic();
  console.log(`built → ${outdir}`);
}
