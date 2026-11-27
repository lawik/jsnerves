// Make the boot snapshot of a jsnerves disk image (see Snapshots in the
// README): boot it in headless Chromium, wait for IEx (and --settle seconds
// more), save the machine, write it gzip-compressed next to blk.txt
// (disk/<id>/snapshot-<hash>.gz, named after its content so it can be cached
// forever; older ones are removed) and name it in blk.txt. Then restore it in
// a fresh browser context and check it: IEx answers, nerves_runtime runs, its
// KV has the active slot and the startup guard is done.
//
// A restore shows the console as it was at the first prompt (see the
// warm-up below). The check matters because nerves_runtime gives up when
// its KV's first load during boot is slow (fwup's status read gets
// `fwup_timeout`, 1 s unless configured, and callers of the KV wait 5 s),
// which a slow emulated boot can miss; nerves_runtime then does not start,
// and a snapshot would keep that forever. A snapshot that fails the check is
// thrown away and the image booted again.
//
// Run it through ../make_snapshot.sh, which installs Playwright first:
//
//   ../make_snapshot.sh [--dir <jsnerves dir, default .>] [--settle 5]
//                       [--level 9] [--attempts 5] [--no-shrink] [--no-warmup]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
};
const dir = path.resolve(opt("dir", "."));
const settle = Number(opt("settle", "5"));
const level = Number(opt("level", "9"));
const shrink = !args.includes("--no-shrink");
const attempts = Number(opt("attempts", "5"));
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

// the disk image the VM boots, from nerves.cfg
if (!fs.existsSync(path.join(dir, "nerves.cfg"))) {
  console.error(`no nerves.cfg in ${dir}: run this in the jsnerves directory, or pass --dir`);
  process.exit(1);
}
const cfg = fs.readFileSync(path.join(dir, "nerves.cfg"), "utf8");
const m = /drive0:\s*\{\s*file:\s*"([^"]+)"/.exec(cfg);
if (!m) throw new Error("no drive0 in nerves.cfg");
const blkPath = path.join(dir, m[1]);
const diskDir = path.dirname(blkPath);
const blkOrig = fs.readFileSync(blkPath, "utf8").replace(/\n\s*snapshot(_size)?:[^\n]*/g, "");

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g, "");

// serve dir on a free localhost port
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".cfg": "text/plain", ".txt": "text/plain",
  ".png": "image/png",
};
const srv = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(dir, path.normalize(rel));
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
});
await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${srv.address().port}/`;

// The warm-up, typed at the prompt of the machine that is saved: it loads
// nerves_runtime's KV (and reports whether nerves_runtime runs), and
// compiles, evaluates and inspects a little, so that the first command
// after a restore does not wait for the compiler's modules to come from the
// disk. It ends by raising, so IEx does not count it and the saved shell is
// still at iex(1)>. Unless --no-shrink, it also drops the page cache and then
// allocates and frees most of the free memory: the kernel zeroes pages it
// hands out, so the stale data in free pages is gone and compresses away.
const SHRINK = 'File.write!("/proc/sys/vm/drop_caches", "3"); ' +
  'free_kb = Regex.run(~r/MemFree:\\s+(\\d+)/, File.read!("/proc/meminfo")) |> Enum.at(1) |> String.to_integer(); ' +
  'zeros = for _ <- 1..max(div(free_kb, 1024) - 12, 0), do: :binary.copy(<<0>>, 1_048_576); ' +
  'length(zeros); zeros = nil; :erlang.garbage_collect(); ';
// It first waits (up to a minute) for Nerves.Runtime's startup guard to
// finish: the guard clears its heart callback once all applications have
// started and the firmware is valid, and a machine saved before that would
// still reboot itself 15 minutes after its boot.
const warmup = (shrink) =>
  '(fn -> guard = Enum.any?(1..120, fn _ -> :heart.get_callback() == :none or (Process.sleep(500) && false) end); ' +
  'health = {Application.started_applications() |> List.keymember?(:nerves_runtime, 0), ' +
  'Nerves.Runtime.KV.get("nerves_fw_active"), guard}; _ = inspect({1 + 1, [a: 1.0], %{"b" => :c}}); ' +
  (shrink ? SHRINK : "") +
  'raise "snapshot warm-up: #{inspect(health)}" end).()';

// boot cold, wait for IEx, warm up, save
async function bootAndSave(browser, attempt) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("page error: " + e.message));
    await page.goto(base + "index.html?snapshot=0&reset=1");
    await page.waitForFunction(() => window.nervesVM && window.nervesVM.stage === "ready",
                               null, { timeout: 180000, polling: 200 });
    const transcript = await page.evaluate(() => window.nervesVM.transcript);
    log(`boot ${attempt}: IEx is ready; waiting ${settle} s`);
    await sleep(settle * 1000);
    if (!args.includes("--no-warmup")) {
      const from = transcript.length;
      await page.evaluate((s) => window.nervesVM.write(s + "\r"), warmup(shrink));
      let out = "", m1 = null;
      for (let i = 0; i < 1500 && !(m1 && /iex\(\d+\)> ?$/.test(out)); i++) {
        await sleep(100);
        out = strip(await page.evaluate((n) => window.nervesVM.transcript.slice(n), from));
        m1 = /snapshot warm-up: \{(true|false), ("\w+"|nil), (true|false)\}/.exec(out);
      }
      const prompt = /iex\((\d+)\)> ?$/.exec(out);
      if (!m1 || !prompt) throw new Error("the warm-up did not finish:\n" + out.slice(-1500));
      if (prompt[1] !== "1") throw new Error(`the warm-up moved the prompt to iex(${prompt[1]})`);
      log(`boot ${attempt}: warmed up, nerves_runtime running: ${m1[1]}, KV nerves_fw_active: ${m1[2]}, ` +
          `startup guard done: ${m1[3]}`);
      if (m1[1] !== "true" || m1[2] === "nil" || m1[3] !== "true")
        return { unhealthy: m1[0] };
      await sleep(1000);
    }
    const download = page.waitForEvent("download");
    const info = await page.evaluate(async (console) => {
      const bytes = await window.nervesVM.saveSnapshot({ console });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes]));
      a.download = "snapshot.bin";
      document.body.appendChild(a);
      a.click();
      return { size: bytes.length, slot: window.nervesVM.slot };
    }, transcript);
    const raw = fs.readFileSync(await (await download).path());
    if (raw.length !== info.size) throw new Error("download size mismatch");
    return { raw, slot: info.slot };
  } finally {
    await ctx.close();
  }
}

// restore it in a fresh context (empty cache and IndexedDB) and check it
async function check(browser) {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => log("page error: " + e.message));
    await page.addInitScript(() => {
      window.__out = "";
      let vm;
      Object.defineProperty(window, "nervesVM", { configurable: true, get: () => vm, set(v) {
        vm = v;
        v.addEventListener("stage", (e) => { if (e.detail.stage === "ready") window.__ready = e.detail; });
        v.addEventListener("console", (e) => { if (!e.detail.replayed) window.__out += e.detail.data; });
      }});
    });
    await page.goto(base + "index.html");
    await page.waitForFunction(() => window.__ready, null, { timeout: 180000, polling: 50 });
    const ready = await page.evaluate(() => window.__ready);
    if (!ready.restored) return { ok: false, why: "not restored" };
    log(`  restored: IEx ready ${(ready.sinceBoot / 1000).toFixed(2)} s after start`);
    const iex = async (expr, re, timeoutS = 30) => {
      const from = await page.evaluate(() => window.__out.length);
      await page.evaluate((s) => window.nervesVM.write(s + "\r"), expr);
      const end = Date.now() + timeoutS * 1000;
      for (;;) {
        const out = strip(await page.evaluate((n) => window.__out.slice(n), from));
        const mm = re.exec(out);
        if (mm) return mm;
        if (Date.now() > end) throw new Error(`no ${re} after ${expr}:\n${out.slice(-2000)}`);
        await sleep(100);
      }
    };
    await iex("1 + 1", /\n2\r?\n/);
    const h = await iex('{Application.started_applications() |> List.keymember?(:nerves_runtime, 0), Nerves.Runtime.KV.get("nerves_fw_active"), :heart.get_callback() == :none}',
                        /\{(true|false), ("\w+"|nil), (true|false)\}\r?\n/);
    log(`  1 + 1 answered; nerves_runtime running: ${h[1]}, KV nerves_fw_active: ${h[2]}, startup guard done: ${h[3]}`);
    return { ok: h[1] === "true" && h[2] !== "nil" && h[3] === "true", why: h[0].trim() };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch();
let done = false, snapPath = null;
try {
  for (let attempt = 1; attempt <= attempts && !done; attempt++) {
    const { raw, slot, unhealthy } = await bootAndSave(browser, attempt);
    if (unhealthy) {
      log(`boot ${attempt}: nerves_runtime is not healthy (${unhealthy}); booting again`);
      continue;
    }
    const gz = zlib.gzipSync(raw, { level });
    const snapName = `snapshot-${crypto.createHash("sha256").update(gz).digest("hex").slice(0, 12)}.gz`;
    snapPath = path.join(diskDir, snapName);
    fs.writeFileSync(snapPath, gz);
    fs.writeFileSync(blkPath, blkOrig.replace(/\}\s*$/, `  snapshot: "${snapName}",\n  snapshot_size: ${gz.length},\n}\n`));
    log(`boot ${attempt}: snapshot ${(raw.length / 1048576).toFixed(1)} MB, ` +
        `${(gz.length / 1048576).toFixed(1)} MB gzip -${level} (slot ${slot}); checking it`);
    const r = await check(browser);
    if (r.ok) {
      log(`saved ${path.relative(dir, snapPath)}, named in ${path.relative(dir, blkPath)}`);
      for (const f of fs.readdirSync(diskDir)) {
        if (/^snapshot.*\.gz$/.test(f) && f !== snapName) {
          fs.rmSync(path.join(diskDir, f));
          log(`removed the old ${f}`);
        }
      }
      done = true;
    } else {
      log(`boot ${attempt}: the snapshot failed the check (${r.why}); booting again`);
      fs.rmSync(snapPath, { force: true });
      snapPath = null;
    }
  }
} finally {
  if (!done) {
    if (snapPath)
      fs.rmSync(snapPath, { force: true });
    fs.writeFileSync(blkPath, blkOrig);
  }
  await browser.close();
  srv.closeAllConnections();
  srv.close();
}
if (!done) {
  console.error("no snapshot: no boot passed the check");
  process.exit(1);
}
