export function migrateLegacyPreferences(storage: Storage = window.localStorage) {
  const fixedKeys = ["client-id", "history-tree", "advanced-actions", "import-title-template", "recent-models", "provider"];
  for (const suffix of fixedKeys) {
    const legacy = `xiteng-chat-${suffix}`;
    const current = `turnfold-${suffix}`;
    if (storage.getItem(current) === null && storage.getItem(legacy) !== null) {
      storage.setItem(current, storage.getItem(legacy)!);
    }
  }
  for (let index = 0; index < storage.length; index += 1) {
    const legacy = storage.key(index);
    if (!legacy?.startsWith("xiteng-chat-model:")) continue;
    const current = legacy.replace(/^xiteng-chat-model:/, "turnfold-model:");
    if (storage.getItem(current) === null) storage.setItem(current, storage.getItem(legacy)!);
  }
}
