export type DomReconcileOptions = {
  preserveChildren?: (element: Element) => boolean;
  beforeDiscard?: (node: Node) => void;
};

const identityAttributes = [
  "data-dom-key",
  "data-message-id",
  "data-id",
  "data-provider",
  "data-model",
  "data-kind",
  "data-format",
  "data-action",
  "name"
];

function nodeKey(node: Node) {
  if (!(node instanceof Element)) return "";
  if (node.id) return `${node.localName}#${node.id}`;
  const parts = identityAttributes
    .filter((name) => node.hasAttribute(name))
    .map((name) => `${name}=${node.getAttribute(name) || ""}`);
  if (!parts.length) return "";
  if (node instanceof HTMLInputElement && (node.type === "radio" || node.type === "checkbox")) parts.push(`value=${node.value}`);
  return `${node.localName}[${parts.join("|")}]`;
}

function nodesMatch(current: Node, desired: Node) {
  if (current.nodeType !== desired.nodeType) return false;
  if (!(current instanceof Element) || !(desired instanceof Element)) return true;
  if (current.localName !== desired.localName || current.namespaceURI !== desired.namespaceURI) return false;
  const currentKey = nodeKey(current);
  const desiredKey = nodeKey(desired);
  return currentKey || desiredKey ? currentKey === desiredKey : true;
}

function syncAttributes(current: Element, desired: Element) {
  const preserveOpen = current instanceof HTMLDetailsElement ? current.open : undefined;
  const currentValue = current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement ? current.value : "";
  const valueIsDirty = current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement
    ? current === document.activeElement || current.value !== current.defaultValue
    : false;

  for (const name of current.getAttributeNames()) {
    if (name === "open" && current instanceof HTMLDetailsElement) continue;
    if (!desired.hasAttribute(name)) current.removeAttribute(name);
  }
  for (const name of desired.getAttributeNames()) {
    if (name === "open" && current instanceof HTMLDetailsElement) continue;
    const value = desired.getAttribute(name) || "";
    if (current.getAttribute(name) !== value) current.setAttribute(name, value);
  }

  if (current instanceof HTMLInputElement && desired instanceof HTMLInputElement) {
    current.checked = desired.checked;
    current.indeterminate = desired.indeterminate;
    if (valueIsDirty) current.value = currentValue;
    else current.value = desired.value;
  } else if (current instanceof HTMLTextAreaElement && desired instanceof HTMLTextAreaElement) {
    if (valueIsDirty) current.value = currentValue;
    else current.value = desired.value;
  }
  if (current instanceof HTMLDetailsElement && preserveOpen !== undefined) current.open = preserveOpen;
}

function discard(node: Node, options: DomReconcileOptions) {
  options.beforeDiscard?.(node);
  node.parentNode?.removeChild(node);
}

function reconcileChildren(current: Element, desired: ParentNode, options: DomReconcileOptions) {
  if (options.preserveChildren?.(current)) return;
  const existing = Array.from(current.childNodes);
  const used = new Set<Node>();
  const keyed = new Map<string, Node[]>();
  for (const child of existing) {
    const key = nodeKey(child);
    if (!key) continue;
    const matches = keyed.get(key) || [];
    matches.push(child);
    keyed.set(key, matches);
  }

  let previous: Node | null = null;
  for (const desiredChild of Array.from(desired.childNodes)) {
    const desiredKey = nodeKey(desiredChild);
    const keyedMatch = desiredKey
      ? keyed.get(desiredKey)?.find((candidate) => !used.has(candidate) && nodesMatch(candidate, desiredChild))
      : undefined;
    const positional: ChildNode | null = previous ? previous.nextSibling : current.firstChild;
    const positionalMatch: Node | null = positional && !used.has(positional) && nodesMatch(positional, desiredChild) ? positional : null;
    const fallbackMatch: Node | null = desiredKey ? null : existing.find((candidate) => !used.has(candidate) && !nodeKey(candidate) && nodesMatch(candidate, desiredChild)) || null;
    const match: Node | null = keyedMatch || positionalMatch || fallbackMatch;
    const target: Node = match || desiredChild.cloneNode(true);
    const anchor: ChildNode | null = previous ? previous.nextSibling : current.firstChild;
    if (target !== anchor) current.insertBefore(target, anchor);
    if (match) {
      used.add(match);
      reconcileNode(match, desiredChild, options);
    }
    previous = target;
  }

  for (const child of existing) if (!used.has(child) && child.parentNode === current) discard(child, options);
  if (current instanceof HTMLSelectElement && desired instanceof HTMLSelectElement && current !== document.activeElement) current.value = desired.value;
}

function reconcileNode(current: Node, desired: Node, options: DomReconcileOptions) {
  if (!nodesMatch(current, desired)) {
    const replacement = desired.cloneNode(true);
    options.beforeDiscard?.(current);
    current.parentNode?.replaceChild(replacement, current);
    return replacement;
  }
  if (current.nodeType === Node.TEXT_NODE || current.nodeType === Node.COMMENT_NODE) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return current;
  }
  if (current instanceof Element && desired instanceof Element) {
    syncAttributes(current, desired);
    reconcileChildren(current, desired, options);
  }
  return current;
}

function parsedFragment(markup: string) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content;
}

export function reconcileHtml(container: Element, markup: string, options: DomReconcileOptions = {}) {
  reconcileChildren(container, parsedFragment(markup), options);
}

export function reconcileElement(current: Element, markup: string, options: DomReconcileOptions = {}) {
  const desired = parsedFragment(markup).firstElementChild;
  if (!desired) {
    discard(current, options);
    return null;
  }
  return reconcileNode(current, desired, options) as Element;
}
