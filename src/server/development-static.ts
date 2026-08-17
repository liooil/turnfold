import path from "node:path";
import {securityHeaders} from "./http";
import {basePath} from "./runtime";
import {staticResponse} from "./static-files";

const publicRoot = path.resolve("public");
const mathJaxRoot = path.resolve("node_modules/mathjax");
const mathJaxFontRoot = path.resolve("node_modules/@mathjax/mathjax-newcm-font");
const appRoot = basePath ? `${basePath}/` : "/";

async function templatedPublicAsset(filename: "manifest.webmanifest" | "sw.js") {
  const source = await Bun.file(path.join(publicRoot, filename)).text();
  const content = source.replaceAll("__BASE_PATH__", basePath).replaceAll("__APP_ROOT__", appRoot);
  const contentType = filename === "sw.js" ? "text/javascript; charset=utf-8" : "application/manifest+json; charset=utf-8";
  return new Response(content, {
    headers: {
      ...securityHeaders,
      "Content-Type": contentType,
      "Cache-Control": "no-cache"
    }
  });
}

export function developmentStaticResponse(pathname: string) {
  if (pathname === "/manifest.webmanifest") return templatedPublicAsset("manifest.webmanifest");
  if (pathname === "/sw.js") return templatedPublicAsset("sw.js");
  if (pathname === "/assets/mathjax/4.1.3/tex-svg-nofont.js") return staticResponse("/tex-svg-nofont.js", {root: mathJaxRoot});

  const mathJaxFontPrefix = "/assets/mathjax/4.1.3/fonts/mathjax-newcm-font/";
  if (pathname.startsWith(mathJaxFontPrefix)) return staticResponse(`/${pathname.slice(mathJaxFontPrefix.length)}`, {root: mathJaxFontRoot});

  const mathJaxExtensionsPrefix = "/assets/mathjax/4.1.3/input/tex/extensions/";
  if (pathname.startsWith(mathJaxExtensionsPrefix)) return staticResponse(`/input/tex/extensions/${pathname.slice(mathJaxExtensionsPrefix.length)}`, {root: mathJaxRoot});

  return staticResponse(pathname, {root: publicRoot});
}
