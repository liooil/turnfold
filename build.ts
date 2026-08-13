import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";

function normalizedBasePath(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

const basePath = normalizedBasePath(process.env.BASE_PATH);
const appRoot = basePath ? `${basePath}/` : "/";
const homeUrl = process.env.HOME_URL?.trim() || appRoot;
const outputDirectory = process.env.OUTPUT_DIR?.trim() || "dist";

rmSync(outputDirectory, {recursive: true, force: true});
mkdirSync(`${outputDirectory}/assets`, {recursive: true});
const result = await Bun.build({
  entrypoints: ["src/client.ts"],
  outdir: `${outputDirectory}/assets`,
  target: "browser",
  minify: true,
  sourcemap: "none",
  naming: "client.js",
  define: {
    __TURNFOLD_BASE_PATH__: JSON.stringify(basePath),
    __TURNFOLD_HOME_URL__: JSON.stringify(homeUrl)
  }
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const version = Bun.hash(`${readFileSync("src/client.ts", "utf8")}\0${readFileSync("src/styles.css", "utf8")}`).toString(36);
writeFileSync(`${outputDirectory}/index.html`, readFileSync("src/index.html", "utf8")
  .replaceAll("__ASSET_VERSION__", version)
  .replaceAll("__BASE_PATH__", basePath)
  .replaceAll("__APP_ROOT__", appRoot));
cpSync("src/styles.css", `${outputDirectory}/styles.css`);
cpSync("public", outputDirectory, {recursive: true});
writeFileSync(`${outputDirectory}/manifest.webmanifest`, readFileSync("public/manifest.webmanifest", "utf8")
  .replaceAll("__BASE_PATH__", basePath)
  .replaceAll("__APP_ROOT__", appRoot));
writeFileSync(`${outputDirectory}/sw.js`, readFileSync("public/sw.js", "utf8")
  .replaceAll("__BASE_PATH__", basePath)
  .replaceAll("__APP_ROOT__", appRoot));
mkdirSync(`${outputDirectory}/assets/mathjax/4.1.3/fonts/mathjax-newcm-font/svg/dynamic`, {recursive: true});
cpSync("node_modules/mathjax/tex-svg-nofont.js", `${outputDirectory}/assets/mathjax/4.1.3/tex-svg-nofont.js`);
cpSync("node_modules/@mathjax/mathjax-newcm-font/svg.js", `${outputDirectory}/assets/mathjax/4.1.3/fonts/mathjax-newcm-font/svg.js`);
cpSync("node_modules/@mathjax/mathjax-newcm-font/svg/dynamic", `${outputDirectory}/assets/mathjax/4.1.3/fonts/mathjax-newcm-font/svg/dynamic`, {recursive: true});
cpSync("node_modules/mathjax/input/tex/extensions", `${outputDirectory}/assets/mathjax/4.1.3/input/tex/extensions`, {recursive: true});
