import {describe, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {webdavRootUrl} from "./webdav-controller.ts";

describe("WebDAV connection", () => {
  test("derives the scoped DAV route only for a Turnfold service", () => {
    expect(webdavRootUrl("https://service.example.test/turnfold", "turnfold"))
      .toBe("https://service.example.test/turnfold/dav/");
    expect(webdavRootUrl("https://storage.example.test/remote.php/dav/files/alice", "basic"))
      .toBe("https://storage.example.test/remote.php/dav/files/alice/");
  });

  test("keeps initialization free of WebDAV network access", () => {
    const source = readFileSync(new URL("./webdav-controller.ts", import.meta.url), "utf8");
    const initializeStart = source.indexOf("function initialize()");
    const authenticationStart = source.indexOf("function authentication(");
    const initializeSource = source.slice(initializeStart, authenticationStart);
    expect(initializeStart).toBeGreaterThan(-1);
    expect(initializeSource).not.toMatch(/\bfetch\s*\(/);
    expect(initializeSource).not.toContain("peer.identity(");
  });
});
