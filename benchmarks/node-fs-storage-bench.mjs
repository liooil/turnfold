// Bun 端 node:fs 存储基准：模拟 FileSystemStorage 的读写模式
import {mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, mkdirSync, openSync, closeSync, readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "tf-fs-bench-"));
const objectsDir = path.join(root, "objects", "2f");
const refsDir = path.join(root, "refs");
const tmpDir = path.join(root, ".tmp");
mkdirSync(objectsDir, {recursive: true});
mkdirSync(refsDir, {recursive: true});
mkdirSync(tmpDir, {recursive: true});

const sampleSmall = JSON.stringify({id: "sha256:ab", parentMessageId: "sha256:cd", role: "assistant", parts: [{type: "text", text: "x".repeat(4000)}], origin: {type: "model"}, completion: {status: "complete"}, createdAt: "2026-08-22T10:00:00.000Z", completedAt: "2026-08-22T10:00:00.000Z"}); // ~5.3KB
const sampleRef = JSON.stringify({id: "sha256:x", name: "测试会话名".repeat(4), headMessageId: "sha256:y", providerId: "anthropic", model: "claude-sonnet-4-5", generationSettings: {reasoning: "auto", showReasoningSummary: false}, headVersion: 42, metadataVersion: 3, createdAt: "2026-08-22T10:00:00.000Z", updatedAt: "2026-08-22T10:00:00.000Z"});
const sampleBig = JSON.stringify({type: "image", data: "A".repeat(1_000_000), mimeType: "image/png"}); // 1MB

function now() { return performance.now(); }
function bench(name, n, fn) {
  const t0 = now();
  for (let i = 0; i < n; i++) fn(i);
  const dt = now() - t0;
  console.log(`${name}: ${(dt / n).toFixed(3)} ms/op (n=${n}), ${(n / dt * 1000).toFixed(0)} ops/s`);
}

// 1. 单对象顺序写（FileSystemStorage 风格：tmp + rename）
bench("写 5KB 对象 (tmp+rename, 无 fsync)", 200, (i) => {
  const tmp = path.join(tmpDir, `t${i}`);
  writeFileSync(tmp, sampleSmall);
  renameSync(tmp, path.join(objectsDir, `obj${i}.json`));
});

// 2. 写 + fsync（真实 durability：每 op 写文件并 fdatasync）
const {fdatasyncSync} = await import("node:fs");
bench("写 5KB 对象 (含 fdatasync)", 100, (i) => {
  const fd = openSync(path.join(tmpDir, `fs${i}`), "w+");
  writeFileSync(fd, sampleSmall);
  fdatasyncSync(fd);
  closeSync(fd);
});

// 3. 单对象顺序读
bench("读 5KB 对象", 500, (i) => {
  readFileSync(path.join(objectsDir, `obj${i % 200}.json`), "utf8");
});

// 4. 单对象随机读（模拟打开会话渲染路径）
const idxs = Array.from({length: 500}, (_, i) => (i * 37) % 200);
bench("读 5KB 对象 (随机)", 500, (i) => {
  readFileSync(path.join(objectsDir, `obj${idxs[i]}.json`), "utf8");
});

// 5. 批量读（list 后 get 全部，模拟历史加载）
const names = readdirSync(objectsDir).map((n) => n);
const files = names.map((n) => path.join(objectsDir, n));
bench(`批量读 ${files.length} 个对象`, 5, () => {
  for (const f of files) readFileSync(f, "utf8");
});

// 6. refs 小文件写（每轮提交 1-2 次，CAS 风格）
bench("写 0.5KB ref (tmp+rename)", 500, (i) => {
  const tmp = path.join(tmpDir, `r${i}`);
  writeFileSync(tmp, sampleRef);
  renameSync(tmp, path.join(refsDir, `r${i}.json`));
});

// 7. 大文件（1MB 图片对象）
const bigPath = path.join(objectsDir, "big.json");
bench("写 1MB 对象 (tmp+rename)", 20, () => {
  const tmp = path.join(tmpDir, "big");
  writeFileSync(tmp, sampleBig);
  renameSync(tmp, bigPath);
});
bench("读 1MB 对象", 50, () => readFileSync(bigPath, "utf8"));

// 8. 目录枚举（模拟 inventory / list）
bench(`枚举 ${files.length + 1} 个对象目录`, 20, () => readdirSync(objectsDir));

rmSync(root, {recursive: true, force: true});
