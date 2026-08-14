export const fullscreenEditorCharacterThreshold = 600;
export const fullscreenEditorLineThreshold = 8;

export function shouldOpenFullscreenEditor(value: unknown) {
  const text = String(value ?? "");
  const lineCount = text ? text.split(/\r?\n/).length : 0;
  return text.length >= fullscreenEditorCharacterThreshold || lineCount >= fullscreenEditorLineThreshold;
}
