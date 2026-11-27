# JSNerves

Nerves running in a web browser: a RISC-V machine emulated by
[TinyEMU](https://bellard.org/tinyemu/) compiled to WebAssembly, booting
OpenSBI, U-Boot and a Nerves firmware image from an A/B disk layout, exactly
as a real device would.

Everything here is static files. Serve the directory and open `index.html`.
`extract_firmware.sh` and `make_snapshot.sh` (with `tools/`) build the disk
image and its snapshot from a Nerves firmware file (see Updating the
firmware); they are not part of the site.

## What is served

| File | Role |
| ---- | ---- |
| `nerves-vm.js` | the JavaScript API: loads the emulator, boots the machine and reports what happens as events (see below) |
| `index.html`, `style.css`, `term.js`, `page.js` | the page: a terminal, the board's LEDs and buttons, and status lines driven by those events |
| `board.js` | the board around the machine: which GPIO lines are LEDs and buttons, and the FPS sensor on I2C (see Board) |
| `net/nerves-net.js`, `net/v86/` | network adapters for the guest (see Networking); loaded only when a network is asked for |
| `riscvemu64-wasm.js`, `riscvemu64-wasm.wasm` | the emulator (built from `../tinyemu`, branch `emscripten-modern`) |
| `nerves.cfg` | VM description: 128 MB RAM, `opensbi.bin` as bios, `u-boot.bin` as kernel, `disk/<id>/blk.txt` as the virtio disk, the GPIO lines (`gpio0`) and an I2C adapter (`i2c0`) |
| `opensbi.bin` | OpenSBI `fw_jump` from the Nerves system |
| `u-boot.bin` | U-Boot (S-mode, HTIF console, virtio-blk) from the Nerves system |
| `disk/<id>/blk*.bin`, `disk/<id>/blk.txt` | the fwup-written disk image in 256 KB blocks, in a directory named after a hash of the image. Blocks that are all zeros are not present: `blk.txt` lists them in `zero` as `[first, count]` ranges so they are never requested (a 404 also reads as zeros). The other blocks are listed in `prefetch`: the emulator downloads them in the background, `prefetch_parallel` (4) at a time, while the guest boots, and fetches any block the guest needs first right away. `blk.txt` also carries an `id` for the persisted writes, and can name a `snapshot` |
| `disk/<id>/snapshot-<hash>.gz` | optional: the machine saved at the IEx prompt, restored instead of booting on a first visit (see Snapshots) |

The disk image holds an MBR, the U-Boot environment with the Nerves
firmware metadata, kernel slots A and B, rootfs partitions A and B and an
f2fs application partition. U-Boot reads `nerves_fw_active` from the
environment and boots that slot. See `fwup_include/fwup-common.conf` in
[nerves_system_jslinux](https://github.com/underjord/nerves_system_jslinux)
for the layout.

## JavaScript API

`nerves-vm.js` defines `NervesVM`, an `EventTarget`. The page subscribes to
its events; nothing polls.

```js
const vm = new NervesVM({ config: "nerves.cfg", cols: 80, rows: 30 });
vm.addEventListener("console", (e) => term.write(e.detail.data));
vm.addEventListener("progress", (e) => {
  const p = e.detail; // loaded, total, percent, bytesPerSecond, secondsLeft, done
  label.textContent = `${p.percent.toFixed(0)}% of ${p.total} bytes`;
});
vm.addEventListener("stage", (e) => console.log(e.detail.stage, e.detail.sinceBoot));
await vm.start();
vm.write("Nerves.Runtime.KV.get_all()\r");
```

Options: `config` (VM configuration file, default `nerves.cfg`),
`emulator` (default `riscvemu64-wasm.js`), `memory` (MB, default 128),
`cols`/`rows` (console size the guest sees), `cmdline`, `resetDisk` (drop
the disk saved in this browser before booting), `logLines` (how many lines
`vm.log` keeps, default 2000), `network` (an adapter, see `sendPacket` in
the source), `snapshot` (default `true`: restore the disk image's snapshot
when there is one; `false` always boots), `waitForDisk` (default `true`: the
machine starts once the whole disk image is downloaded, and the snapshot
restored, so it never waits for the network; `false` starts it right away
and loads the image while it runs).

Events (the payload is in `event.detail`):

| Event | Detail | When |
| ----- | ------ | ---- |
| `console` | `{data, replayed}` | console output as it arrives, escape sequences and all; after a restore, the snapshot's console comes first with `replayed: true` |
| `line` | `{text, time}` | each complete console line without escape sequences; `time` is ms since `start()`. The last lines are in `vm.log` |
| `stage` | `{stage, label, previous, time, sinceBoot, slot, restored}` | boot progress: `loading` (the emulator), `opensbi`, `uboot`, `linux`, `init` (erlinit), `erlang`, `ready` (the IEx prompt); `reset` when the guest reboots and `off` when it powers off. `slot` is the firmware slot U-Boot booted. Recognized from the console output. `downloading` while the machine waits for the download. With a snapshot, `ready` with `restored: true` once it runs (`restoring` instead of `downloading` with `waitForDisk: false`) |
| `snapshot` | `{phase, url, loaded, total, percent, bytesPerSecond, secondsLeft, elapsed, message}` | restoring a snapshot: `start`, `progress` (the download, compressed bytes), `restored`; or `skipped`/`error` (`message`), after which the machine boots as usual |
| `download` | `{loaded, total, percent, bytesPerSecond, secondsLeft, elapsed, done}` | everything downloaded before the machine runs: the disk image, plus the snapshot when one is restored. Same pacing as `progress`. The page's progress bar shows this |
| `progress` | `{loaded, total, percent, bytesPerSecond, secondsLeft, blocksLoaded, blocksTotal, elapsed, done}` | download of the disk image (every block in `blk.txt` that is not all zeros), at most every 100 ms and once more when done. The speed is over the last 3 seconds |
| `disk` | `{status, savedBytes, restoredBytes}` | disk persistence: `on`, `off` or `error` |
| `reset` | `{}` | the guest rebooted the machine |
| `poweroff` | `{status}` | the guest powered the machine off |
| `power` | `{on}` | the machine has power: on once it runs (a reboot keeps it on), off when it powers off. `vm.powered` |
| `gpio` | `{line, name, direction, value, input, on}` | a GPIO line changed (see Board); each line once when the machine is created, and again after a snapshot restore |
| `error` | `{message}` | the emulator or a block could not be loaded |

`vm.stage`, `vm.slot`, `vm.download`, `vm.progress`, `vm.disk` and `vm.log` hold the
latest values, `vm.transcript` the console output so far. `vm.write(str)`
types into the console. `vm.saveSnapshot()` resolves to a snapshot of the
running machine (see Snapshots). `NervesVM.resetDisk()`
deletes the saved disk. The emulator keeps its state in globals, so a page
can run one `NervesVM`; `page.js` sets `window.nervesVM` for the browser
console.

The emulator side of this is in `../tinyemu/js/lib.js`: every call it makes
into the page goes through an optional callback on `Module` (`onConsoleOutput`,
`onFetch`, `onDiskInfo`, `onDiskPersist`, `onReset`, `onPowerOff`,
`onNetPacket`, `onSnapshot`, `onWaiting`, `onRun`, `onGpio`, `onI2C`), which
`nerves-vm.js` sets.

## Board

`nerves.cfg` gives the machine a virtio GPIO controller and a virtio I2C
adapter:

```
gpio0: { lines: ["LED_SLOT_A", "LED_SLOT_B", "LED_READY",
                 "BUTTON_1", "BUTTON_2", "BUTTON_3"] },
i2c0: {},
```

Linux has drivers for both (`/dev/gpiochip0` with those line names, and
`/dev/i2c-0`), so the firmware uses them with Circuits.GPIO and Circuits.I2C
as on any board (`WebDemoNerves.Board` in `../web-demo-nerves`). The other
side of the lines and the bus is the page:

- `vm.gpio` lists the lines: `{line, name, direction, value, input, on}`,
  where `direction` is `none` (not in use), `out` or `in`, `value` is what
  the guest drives, `input` the level the page drives and `on` means an
  output driven high. The `gpio` event reports each change.
- `vm.setInput(name, level)` drives an input (1 while a button is held),
  `vm.press(name, ms)` presses and releases it. Edges reach the guest as
  interrupts.
- `vm.attachI2C(address, device)` puts a device at a 7-bit address:
  `device.write(bytes)` gets each write and `device.read(length)` answers
  each read. An address with nothing attached does not acknowledge.
  `NervesVM.I2CRegisters` is a register file with a pointer, the usual
  sensor protocol (write the register number, then read).

`board.js` says what this board's lines and devices are, and is the API to
use for showing it (the panel under the terminal does, and so can a 3D
model of the board on another page):

```js
const board = NervesBoard.attach(vm);       // before or after vm.start()
board.addEventListener("led", (e) => light(e.detail.led, e.detail.on));
board.leds;                 // {power, ready, slotA, slotB}: true if lit
board.button("BUTTON_1", true);             // hold it; false lets go
await board.press("BUTTON_2");              // press and release
board.fps.set(59.8);        // the FPS sensor reports this rate
board.fps.measure();        // back to measuring this page's frame rate
```

| | What | Driven by |
| - | ---- | --------- |
| `power` LED (red) | the machine has power | the page: on while the machine runs |
| `ready` LED (green), `LED_READY` | the system is up | the firmware: on once its application runs; off when Erlang stops (a reboot, a power off) |
| `slotA`, `slotB` LEDs, `LED_SLOT_A`, `LED_SLOT_B` | the firmware slot that runs | the firmware, from `nerves_fw_active` |
| `BUTTON_1` to `BUTTON_3` | buttons, 1 while pressed | the page; the firmware logs presses for now |
| FPS sensor, I2C `0x10` | frames per second the page renders | the page; register 0 is an ID (`0x46`), registers 1-2 the rate in hundredths, big-endian. `WebDemoNerves.Board.fps()` reads it |

GPIO lines go back to unused (the LEDs off) when the machine resets, and a
snapshot keeps them, so a restored machine shows its LEDs lit.

## Networking

The machine has a virtio-net interface only when the page passes a network
adapter (`network` option; `page.js` does it for `?wisp=` or `?ethernet=`).
`net/nerves-net.js` has two:

- `wisp(url)`: the network lives in the page. v86's network stack
  (`net/v86/`, BSD licensed, copied unchanged) answers DHCP (the guest gets
  192.168.86.100, the router is .1), DNS (forwarded as DNS over HTTPS),
  NTP (from the browser's clock) and ping, and ends every TCP connection the
  guest opens in the browser. The byte streams travel over one WebSocket to
  a [Wisp](https://github.com/MercuryWorkshop/wisp-protocol) server
  (e.g. `@mercuryworkshop/wisp-js`), which opens the real connections.
  TLS stays end to end between the guest and the far end. Connections into
  the guest: `adapter.connect(port)` from the page, or `expose()` to put a
  guest port behind a relay so that `ssh` from anywhere reaches nerves_ssh.
- `ethernet(url)`: raw Ethernet frames over a WebSocket to a relay that
  bridges them to a real network (the JSLinux "wsproxy" protocol).

The firmware has to bring eth0 up. The default `../web-demo-nerves` firmware
leaves networking out; its `networking` branch adds vintage_net (DHCP on
eth0), nerves_time and nerves_ssh. Try it with a local Wisp server:

```sh
npm i @mercuryworkshop/wisp-js && npx wisp-js-server --port 6001   # or any Wisp server
python3 -m http.server 8000
# http://localhost:8000/index.html?wisp=ws://localhost:6001/
```

The emulator needed 256-entry virtqueues for this (TinyEMU had 16, which
stalls Linux's virtio-net transmit queue).

## Persistence

Everything the guest writes to the disk (the U-Boot environment, the
application partition, a firmware slot being upgraded) lands in 4 KB clusters
inside the emulator, and those clusters are saved to IndexedDB in the
browser and restored before the next boot. The status line under the
console shows how much has been saved; its "reset disk" link (or opening
`index.html?reset=1`) throws the saved clusters away and boots the pristine
image again.

Only data the guest has flushed to the disk can be saved: closing the tab
is a power cut as far as Nerves is concerned. The system therefore ships a
pre-formatted application partition and mounts it `sync,dirsync`, so file
writes and directory changes are durable as soon as they return.

Saved clusters are keyed by the `id` in `blk.txt`, which
`extract_firmware.sh` sets from a hash of the disk image, so publishing a new
firmware starts visitors from a clean disk instead of mixing old blocks with
new ones.

## Snapshots

By default the page downloads first and then runs: the machine starts
once the whole disk image is in the browser, so it never waits for the
network afterwards. A boot then takes another 15-20 s of emulated CPU on a
fast machine (most of it starting the Erlang release). A snapshot skips
that: the machine saved at the IEx prompt, about 54 MB of RAM (its pages
that are not all zeros), CPU and device state, and the disk writes of that
boot, gzip-compressed to 14 MB. It downloads together with the disk image
and streams straight into the emulator's RAM, and the machine is at the
IEx prompt as soon as both are in; the console shows the boot log as it
was.

Time to a working IEx on a first visit (headless Chromium, `tti.mjs` in
`../jsnerves-checks`):

| Link | Snapshot (40 MB) | Boot (27 MB, then boot) |
| ---- | ---------------- | ----------------------- |
| 100 Mbit/s | 4.0 s | 20.8 s |
| 25 Mbit/s | 14.3 s | 27.4 s |
| 8 Mbit/s | 43.4 s | 46.3 s |
| 4 Mbit/s | 86.3 s | 74.6 s |

Below about 8 Mbit/s the snapshot takes longer to download than the boot
it saves. With `?lazy=1` (`waitForDisk: false`) only the snapshot is
waited for and the disk image loads while the machine runs, which then
waits for any block it reads first.

A boot needs a reasonably fast CPU: nerves_runtime's start-up has
timeouts (fwup's ops.fw tasks, and the 5 s that callers of
`Nerves.Runtime.KV` wait while it first loads). The firmware raises the
fwup one to 4 s, and boots are healthy with the page's CPU throttled 3x
(`boot-health.mjs` in `../jsnerves-checks`); at 4x, KV's first load takes
longer than the 5 s `Nerves.Runtime.Init` waits for it and nerves_runtime
does not start. A snapshot restore does not boot, so it is not affected;
reboots and visits with saved disk changes are.

When it is used: `blk.txt` names it (`snapshot: "snapshot-<hash>.gz"`) and no
disk changes are saved in this browser (they would not match the
snapshot's memory). The snapshot's own disk writes are saved with the
guest's first write; from then on a visit boots normally on the saved disk,
until "reset disk". A reboot (`Nerves.Runtime.reboot()`) is always a real
boot. `?snapshot=0` (or `snapshot: false`) boots instead.

A snapshot belongs to one disk image, `nerves.cfg` (RAM size, devices) and
emulator build: one that does not fit is refused (the machine boots), so
regenerate it whenever any of them changes. `extract_firmware.sh` makes
one for each new image; after changing `nerves.cfg` or the emulator, run

```sh
./make_snapshot.sh
```

It boots the image in headless Chromium, waits for the prompt and
Nerves.Runtime's startup guard, types a warm-up (loads nerves_runtime's KV
and the compiler's first modules, then drops the page cache and zeroes the
free memory so the snapshot compresses well; the prompt stays `iex(1)>`),
calls `nervesVM.saveSnapshot()`, gzips the result into
`disk/<id>/snapshot-<hash>.gz` and names it in `blk.txt`. Then it restores
the snapshot in a fresh browser and checks that IEx answers, nerves_runtime
runs and the startup guard is done; a boot that fails this (see above) is
thrown away and the image booted again, up to 5 times. It needs Node.js
20.11 or later; the first run installs Playwright into `tools/node_modules`
and its headless Chromium (about 300 MB unpacked) into Playwright's cache.
On Linux, if that Chromium cannot start for missing libraries, run `sudo
npx playwright install-deps chromium` in `tools/`. Options are in
`tools/make_snapshot.mjs`.

Every visitor restores the same machine, random state included (the
kernel reseeds from the virtio-rng over time).

## Reboot and power off

A reboot from the guest (`Nerves.Runtime.reboot()`, or `reset` in U-Boot)
resets the emulated machine in place: OpenSBI, U-Boot and Linux start
again on the same page with the disk as the guest left it, so U-Boot boots
whichever slot the environment now selects. A firmware upgrade written
with `fwup -t upgrade` therefore boots on the next reboot, and reverts on
the one after if it is not validated. A power off stops the machine and
says so in the console; reloading the page boots it again.

## Updating the firmware

Build the firmware in `../web-demo-nerves`, then:

```sh
./extract_firmware.sh ../web-demo-nerves/_build/jslinux_dev/nerves/images/web_demo_nerves.fw \
  ~/.nerves/artifacts/nerves_system_jslinux-portable-0.4.3/images
python3 -m http.server 8000
```

The second argument is the Nerves system's `images/` directory: where
`mix deps.get` puts the prebuilt system (the `v0.4.3` release of
underjord/nerves_system_jslinux), or
`.nerves/artifacts/nerves_system_jslinux-portable-<version>/images` in a
system checkout built from source. The script uses GNU tools (`split -d`,
`stat -c`, `truncate`, `sed -i`); on a Mac, put Homebrew's coreutils and
gnu-sed `gnubin` directories first on PATH.

`extract_firmware.sh` writes the disk image with `fwup -a -t complete`, splits
it into blocks in `disk/<id>/` (replacing `disk/`), drops the empty ones (and
lists them in `blk.txt`), lists the others for prefetching, points `drive0` in
`nerves.cfg` at the new `blk.txt`, and copies OpenSBI and U-Boot from the
system's `images/` directory. Then it runs `make_snapshot.sh` for the new
image's snapshot (about a minute; see Snapshots), which needs Node.js.
`--no-snapshot` (the first argument) skips it, and the page then boots
the image.

## Hosting

Everything is static files (about 27 MB, 41 MB with the snapshot), so any static host works: no
server code, no special headers. Serving `.wasm` as `application/wasm` is
the only nicety. The scripts and `tools/` need not be deployed.

Each disk image lives in `disk/<id>/`, named after a hash of the image, so a
new firmware gets new URLs: the blocks and the snapshot (named after its own
hash) can be cached forever (`Cache-Control: public, max-age=31536000,
immutable`). `nerves.cfg` says which image to boot and `blk.txt` which
snapshot to restore, so they, `index.html` and the scripts want a short
cache time or revalidation. Otherwise a visitor's browser or a CDN could
mix an old cached file with the new image (a snapshot that does not fit is
refused, and the machine boots). `extract_firmware.sh` removes the older image; a
deploy that keeps the previous `disk/<id>/` online for a while also lets
visitors with a cached `nerves.cfg` still boot it.

## Page parameters

Query parameters on `index.html`: `url=` another `.cfg`, `cols=`/`rows=`
terminal size (default 80x30), `font_size=` (default 17px, shrunk to fit the
viewport), `mem=` RAM in MB, `reset=1` to discard the persisted disk,
`debug=1` to log the console lines and boot stages to the browser console,
`snapshot=0` to boot instead of restoring a snapshot, `lazy=1` to run the
machine while the disk image downloads, `board=0` to hide the board panel,
`wisp=`/`ethernet=`/`expose=` for networking (see above).

## Rebuilding the emulator

```sh
cd ../tinyemu
source ~/emsdk/emsdk_env.sh
make -f Makefile.js js/riscvemu64-wasm.js
cp js/riscvemu64-wasm.js js/riscvemu64-wasm.wasm ../jsnerves/
```

A native `temu` (`make CONFIG_SDL= CONFIG_FS_NET= CONFIG_SLIRP= temu`) runs
the same `opensbi.bin`, `u-boot.bin` and a raw disk image for debugging;
`TEMU_TRACE=1` dumps CPU state periodically.
