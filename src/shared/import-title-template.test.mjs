import {describe, expect, test} from "bun:test";
import {applyImportTitleTemplate, importFileStem, importSourceFolder} from "./import-title-template.ts";

const context = {
  title: "Repair auth",
  format: "codex",
  file: "rollout-123",
  folder: "13",
  date: "2026-08-13",
  model: "gpt-5.6-sol",
  provider: "openai",
  index: 7
};

describe("import title templates", () => {
  test("renders paths and import metadata", () => {
    expect(applyImportTitleTemplate("{format}/{date}/{title}", context)).toBe("codex/2026-08-13/Repair auth");
    expect(applyImportTitleTemplate("{index} · {file} · {model}", context)).toBe("7 · rollout-123 · gpt-5.6-sol");
  });

  test("defaults to the source title and rejects unknown variables", () => {
    expect(applyImportTitleTemplate("", context)).toBe("Repair auth");
    expect(() => applyImportTitleTemplate("{project}/{title}", context)).toThrow("未知标题变量");
  });

  test("extracts source file and folder labels", () => {
    expect(importFileStem("backup.turnfold.json")).toBe("backup");
    expect(importFileStem("rollout.jsonl")).toBe("rollout");
    expect(importSourceFolder("sessions.zip / nested / rollout.jsonl")).toBe("nested");
  });
});
