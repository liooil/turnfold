import {cpSync, mkdirSync, readdirSync, rmSync} from "node:fs";
import {join} from "node:path";
import {buildFrontend} from "./build";

const sourceDirectory = "docs";
const outputDirectory = "pages-dist";

rmSync(outputDirectory, {recursive: true, force: true});
mkdirSync(outputDirectory, {recursive: true});

for (const entry of readdirSync(sourceDirectory, {withFileTypes: true})) {
  if (entry.name === "app") continue;
  cpSync(join(sourceDirectory, entry.name), join(outputDirectory, entry.name), {recursive: true});
}

await buildFrontend({
  outputDirectory: join(outputDirectory, "app"),
  basePath: "/turnfold/app",
  homeUrl: "/turnfold/"
});
