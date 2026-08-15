import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";

function normalizedBasePath(value: string | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export type FrontendBuildOptions = {
  minify?: boolean;
  outputDirectory?: string;
  basePath?: string;
  homeUrl?: string;
};

export type StaticAssetsOptions = {
  outputDirectory?: string;
  basePath?: string;
};

function staticAssetOptions(options: StaticAssetsOptions) {
  const basePath = normalizedBasePath(options.basePath ?? process.env.BASE_PATH);
  const appRoot = basePath ? `${basePath}/` : "/";
  const outputDirectory = options.outputDirectory?.trim() || process.env.OUTPUT_DIR?.trim() || "dist";
  return {basePath, appRoot, outputDirectory};
}

export function prepareStaticAssets(options: StaticAssetsOptions = {}) {
  const {basePath, appRoot, outputDirectory} = staticAssetOptions(options);

  mkdirSync(outputDirectory, {recursive: true});
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
}

export async function buildFrontend(options: FrontendBuildOptions = {}) {
  const basePath = normalizedBasePath(options.basePath ?? process.env.BASE_PATH);
  const appRoot = basePath ? `${basePath}/` : "/";
  const homeUrl = options.homeUrl?.trim() || process.env.HOME_URL?.trim() || appRoot;
  const outputDirectory = options.outputDirectory?.trim() || process.env.OUTPUT_DIR?.trim() || "dist";

  rmSync(outputDirectory, {recursive: true, force: true});
  mkdirSync(outputDirectory, {recursive: true});
  const result = await Bun.build({
    entrypoints: ["src/index.html"],
    outdir: outputDirectory,
    target: "browser",
    minify: options.minify ?? true,
    sourcemap: "none",
    define: {
      __TURNFOLD_BASE_PATH__: JSON.stringify(basePath),
      __TURNFOLD_HOME_URL__: JSON.stringify(homeUrl)
    }
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Frontend build failed");
  }

  const bundledHtml = readFileSync(`${outputDirectory}/index.html`, "utf8");
  const version = Bun.hash(bundledHtml).toString(36);
  const extraHead = [
    `<link rel="manifest" href="${basePath}/manifest.webmanifest?v=${version}">`,
    `<link rel="icon" href="${basePath}/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="${basePath}/icons/apple-touch-icon.png" sizes="180x180">`
  ].join("\n");
  writeFileSync(`${outputDirectory}/index.html`, bundledHtml.replace("</head>", `${extraHead}\n</head>`));

  prepareStaticAssets({outputDirectory, basePath});
}

if (import.meta.main) {
  try {
    await buildFrontend();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
