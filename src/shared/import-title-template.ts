export type ImportTitleContext = {
  title: string;
  format: string;
  file: string;
  folder: string;
  date: string;
  model: string;
  provider: string;
  index: number;
};

const placeholders = new Set(["title", "format", "file", "folder", "date", "model", "provider", "index"]);

export function applyImportTitleTemplate(template: string, context: ImportTitleContext) {
  const source = template.trim() || "{title}";
  const unknown = [...source.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter((name) => !placeholders.has(name));
  if (unknown.length) throw new Error(`未知标题变量：${[...new Set(unknown)].map((name) => `{${name}}`).join("、")}`);
  const values: Record<string, string> = {...context, index: String(context.index)};
  const rendered = source.replace(/\{([^{}]+)\}/g, (match, name) => values[name] ?? match).trim();
  return rendered || context.title.trim() || "导入的会话";
}

export function importFileStem(filename: string) {
  return filename.replace(/\.turnfold\.json$/i, "").replace(/\.(?:jsonl|json)$/i, "");
}

export function importSourceFolder(source: string) {
  const parts = source.replaceAll("\\", "/").split("/").map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts.at(-2)! : "";
}
