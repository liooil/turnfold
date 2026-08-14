export function compactModelName(value: unknown) {
  const name = String(value ?? "").trim();
  const tagIndex = name.indexOf(":");
  return tagIndex > 0 ? name.slice(0, tagIndex) : name;
}
