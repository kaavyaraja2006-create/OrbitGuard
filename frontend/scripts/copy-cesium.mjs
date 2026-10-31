// Copies Cesium's static runtime (workers, assets, widgets CSS) into
// public/cesium so it is served at /cesium without a CDN or Cesium ion token.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cesiumRoot = join(dirname(require.resolve("cesium/package.json")), "Build", "Cesium");
const dest = join(process.cwd(), "public", "cesium");
if (!existsSync(cesiumRoot)) {
  console.error("Cesium build not found at", cesiumRoot);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
for (const dir of ["Workers", "ThirdParty", "Assets", "Widgets"]) {
  cpSync(join(cesiumRoot, dir), join(dest, dir), { recursive: true });
}
console.log("Cesium static assets copied to public/cesium");
