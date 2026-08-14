import {describe, expect, test} from "bun:test";
import {readdirSync, readFileSync} from "node:fs";
import path from "node:path";

function sourceFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : entry.name.endsWith(".ts") ? [filename] : [];
  });
}

function imports(filename) {
  const source = readFileSync(filename, "utf8");
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1]);
}

function forbiddenImports(directory, forbiddenSegments) {
  return sourceFiles(directory).flatMap((filename) => imports(filename)
    .filter((specifier) => forbiddenSegments.some((segment) => specifier.includes(segment)))
    .map((specifier) => `${path.relative(process.cwd(), filename)} -> ${specifier}`));
}

describe("source dependency boundaries", () => {
  test("shared code does not depend on client or server code", () => {
    expect(forbiddenImports("src/shared", ["/client/", "/server/"])).toEqual([]);
  });

  test("client code does not depend on server code", () => {
    expect(forbiddenImports("src/client", ["/server/"])).toEqual([]);
  });

  test("server code does not depend on client code", () => {
    expect(forbiddenImports("src/server", ["/client/"])).toEqual([]);
  });
});
