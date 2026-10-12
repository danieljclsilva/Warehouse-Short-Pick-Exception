import { build } from "esbuild";

await build({
  entryPoints: ["scripts/push-worker.ts"],
  outfile: "build/push-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  packages: "external",
  sourcemap: true,
});
