import {unzip} from "fflate";

export type ImportSourceFile = {file: File; source: string};

function sessionFileCandidate(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith(".json") || lower.endsWith(".jsonl");
}

function archiveFileCandidate(name: string) {
  return name.toLowerCase().endsWith(".zip");
}

async function filesFromZip(archive: File) {
  const archiveBytes = new Uint8Array(await archive.arrayBuffer());
  let acceptedBytes = 0;
  let acceptedFiles = 0;
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(archiveBytes, {
      filter(entry) {
        if (!sessionFileCandidate(entry.name) || entry.originalSize > 64 * 1024 * 1024) return false;
        if (acceptedFiles >= 2_000 || acceptedBytes + entry.originalSize > 512 * 1024 * 1024) return false;
        acceptedFiles += 1;
        acceptedBytes += entry.originalSize;
        return true;
      }
    }, (error, result) => error ? reject(error) : resolve(result));
  });
  return Object.entries(entries).map(([name, bytes]) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return {
      file: new File([copy.buffer], name, {type: name.toLowerCase().endsWith(".jsonl") ? "application/x-ndjson" : "application/json"}),
      source: `${archive.name} / ${name}`
    };
  });
}

export async function expandImportFiles(files: Iterable<File>) {
  const expanded: ImportSourceFile[] = [];
  for (const file of files) {
    if (sessionFileCandidate(file.name)) expanded.push({file, source: file.webkitRelativePath || file.name});
    else if (archiveFileCandidate(file.name)) expanded.push(...await filesFromZip(file));
  }
  return expanded;
}

export async function filesFromDirectory(handle: FileSystemDirectoryHandle) {
  const files: ImportSourceFile[] = [];
  let visited = 0;
  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    const entries = (directory as FileSystemDirectoryHandle & {values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>}).values();
    for await (const entry of entries) {
      visited += 1;
      if (visited > 25_000) throw new Error("文件夹内容过多；请直接选择 sessions 或 projects 目录，而不是整个主目录");
      const path = `${prefix}/${entry.name}`;
      if (entry.kind === "directory") {
        if (["node_modules", ".git", "cache", "logs"].includes(entry.name.toLowerCase())) continue;
        await walk(entry, path);
      } else if (sessionFileCandidate(entry.name)) {
        if (files.length >= 2_000) throw new Error("检测到超过 2000 个会话文件；请分批选择更小的目录");
        files.push({file: await entry.getFile(), source: path});
      }
    }
  };
  await walk(handle, handle.name);
  return files;
}
