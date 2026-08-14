import {cpSync, mkdirSync, readdirSync, rmSync} from "node:fs";
import {join} from "node:path";

const sourceDirectory = "docs";
const outputDirectory = "pages-dist";

rmSync(outputDirectory, {recursive: true, force: true});
mkdirSync(outputDirectory, {recursive: true});

for (const entry of readdirSync(sourceDirectory, {withFileTypes: true})) {
  if (entry.name === "app") continue;
  cpSync(join(sourceDirectory, entry.name), join(outputDirectory, entry.name), {recursive: true});
}

process.env.OUTPUT_DIR = join(outputDirectory, "app");
process.env.BASE_PATH = "/turnfold/app";
process.env.HOME_URL = "/turnfold/";

await import("./build");
