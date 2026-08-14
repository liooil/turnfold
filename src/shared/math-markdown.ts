const mathPattern = /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|\\\[[\s\S]*?\\\]|\\\([^\n]*?\\\)|(?<![\\$])\$(?!\$)(?:\\.|[^\\$\n])+?(?<!\\)\$(?!\$)/g;
const tokenPattern = /\uE000turnfold-math-(\d+)\uE001/g;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}

export function protectMath(value: string) {
  const fragments: string[] = [];
  const source = value.replace(mathPattern, (fragment) => {
    const index = fragments.push(fragment) - 1;
    return `\uE000turnfold-math-${index}\uE001`;
  });
  return {source, fragments};
}

function mathFragmentKey(fragment: string, index: number) {
  let hash = 2166136261;
  for (let offset = 0; offset < fragment.length; offset += 1) {
    hash ^= fragment.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  return `${index}-${fragment.length}-${(hash >>> 0).toString(36)}`;
}

export function restoreMath(value: string, fragments: string[]) {
  return value.replace(tokenPattern, (_token, rawIndex: string, offset: number) => {
    const index = Number(rawIndex);
    const fragment = fragments[index] || "";
    const codeStart = value.lastIndexOf("<code", offset);
    const codeEnd = value.lastIndexOf("</code>", offset);
    if (codeStart > codeEnd) return escapeHtml(fragment);
    return `<span class="math-fragment" data-math-key="${mathFragmentKey(fragment, index)}">${escapeHtml(fragment)}</span>`;
  });
}
