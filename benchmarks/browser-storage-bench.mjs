import {chromium} from "playwright-core";
import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {extname} from "node:path";

const server = createServer((req, res) => {
  const file = req.url === "/" ? "/bench.html" : req.url.split("?")[0];
  try {
    const body = readFileSync(new URL(`.${file}`, import.meta.url));
    res.writeHead(200, {"content-type": file.endsWith(".html") ? "text/html" : "text/plain"});
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(3999, r));

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://127.0.0.1:3999/bench.html", {waitUntil: "load"});
let done = false;
await page.waitForFunction(() => document.getElementById("out").textContent.includes("DONE") || document.getElementById("out").textContent.includes("Error"), null, {timeout: 300000}).catch(() => {});
const text = await page.evaluate(() => document.getElementById("out").textContent);
console.log(text);
await browser.close();
server.close();
