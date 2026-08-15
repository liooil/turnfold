export function isViewportAtBottom(viewport: HTMLElement | null): boolean {
  if (!viewport) return false;
  return viewport.scrollHeight - viewport.clientHeight <= viewport.scrollTop + 8;
}

export function scrollBottom(root: HTMLElement, behavior: ScrollBehavior = "auto") {
  const viewport = root.querySelector<HTMLElement>("#thread-viewport");
  if (viewport) viewport.scrollTo({top: viewport.scrollHeight, behavior});
}
