# JSNerves

Nerves running in a web browser: a RISC-V machine emulated by
[TinyEMU](https://bellard.org/tinyemu/) compiled to WebAssembly, booting
OpenSBI, U-Boot and a Nerves firmware image from an A/B disk layout, exactly
as a real device would.

Everything here is static files. Serve the directory and open `index.html`.

## What is served

| File | Role |
| ---- | ---- |
| `nerves-vm.js` | the JavaScript API: loads the emulator, boots the machine and reports what happens as events (see below) |
| `index.html`, `style.css`, `term.js`, `page.js` | the page: a terminal and status lines driven by those events |
| `net/nerves-net.js`, `net/v86/` | network adapters for the guest (see Networking); loaded only when a network is asked for |
| `riscvemu64-wasm.js`, `riscvemu64-wasm.wasm` | the emulator (built from `../tinyemu`, branch `emscripten-modern`) |
| `nerves.cfg` | VM description: 128 MB RAM, `opensbi.bin` as bios, `u-boot.bin` as kernel, `disk/` as the virtio disk |
| `opensbi.bin` | OpenSBI `fw_jump` from the Nerves system |
| `u-boot.bin` | U-Boot (S-mode, HTIF console, virtio-blk) from the Nerves system |
| `disk/blk*.bin`, `disk/blk.txt` | the fwup-written disk image in 256 KB blocks. Blocks that are all zeros are not present: `blk.txt` lists them in `zero` as `[first, count]` ranges so they are never requested (a 404 also reads as zeros). The other blocks are listed in `prefetch`: the emulator downloads them in the background, `prefetch_parallel` (4) at a time, while the guest boots, and fetches any block the guest needs first right away. `blk.txt` also carries an `id` for the persisted writes |

The disk image holds an MBR, the U-Boot environment with the Nerves
firmware metadata, kernel slots A and B, rootfs partitions A and B and an
f2fs application partition. U-Boot reads `nerves_fw_active` from the
environment and boots that slot. See `fwup_include/fwup-common.conf` in
`../nerves_system_jslinux` for the layout.

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
the source).

Events (the payload is in `event.detail`):

| Event | Detail | When |
| ----- | ------ | ---- |
| `console` | `{data}` | console output as it arrives, escape sequences and all |
| `line` | `{text, time}` | each complete console line without escape sequences; `time` is ms since `start()`. The last lines are in `vm.log` |
| `stage` | `{stage, label, previous, time, sinceBoot, slot}` | boot progress: `loading` (the emulator), `opensbi`, `uboot`, `linux`, `init` (erlinit), `erlang`, `ready` (the IEx prompt); `reset` when the guest reboots and `off` when it powers off. `slot` is the firmware slot U-Boot booted. Recognized from the console output |
| `progress` | `{loaded, total, percent, bytesPerSecond, secondsLeft, blocksLoaded, blocksTotal, elapsed, done}` | download of the disk image (every block in `blk.txt` that is not all zeros), at most every 100 ms and once more when done. The speed is over the last 3 seconds |
| `disk` | `{status, savedBytes, restoredBytes}` | disk persistence: `on`, `off` or `error` |
| `reset` | `{}` | the guest rebooted the machine |
| `poweroff` | `{status}` | the guest powered the machine off |
| `error` | `{message}` | the emulator or a block could not be loaded |

`vm.stage`, `vm.slot`, `vm.progress`, `vm.disk` and `vm.log` hold the
latest values. `vm.write(str)` types into the console. `NervesVM.resetDisk()`
deletes the saved disk. The emulator keeps its state in globals, so a page
can run one `NervesVM`; `page.js` sets `window.nervesVM` for the browser
console.

The emulator side of this is in `../tinyemu/js/lib.js`: every call it makes
into the page goes through an optional callback on `Module` (`onConsoleOutput`,
`onFetch`, `onDiskInfo`, `onDiskPersist`, `onReset`, `onPowerOff`,
`onNetPacket`), which `nerves-vm.js` sets.

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

The firmware has to bring eth0 up: the `networking` branch of
`../web-demo-nerves` adds vintage_net (DHCP on eth0), nerves_time and
nerves_ssh. Try it with a local Wisp server:

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

Saved clusters are keyed by the `id` in `disk/blk.txt`, which
`extract_firmware.sh` sets from a hash of the disk image, so publishing a new
firmware starts visitors from a clean disk instead of mixing old blocks with
new ones.

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
  ../nerves_system_jslinux/.nerves/artifacts/nerves_system_jslinux-portable-*/images
python3 -m http.server 8000
```

`extract_firmware.sh` writes the disk image with `fwup -a -t complete`, splits
it into blocks, drops the empty ones (and lists them in `blk.txt`), lists the
others for prefetching, and copies OpenSBI and U-Boot from the system's
`images/` directory.

## Page parameters

Query parameters on `index.html`: `url=` another `.cfg`, `cols=`/`rows=`
terminal size (default 80x30), `font_size=` (default 17px, shrunk to fit the
viewport), `mem=` RAM in MB, `reset=1` to discard the persisted disk,
`debug=1` to log the console lines and boot stages to the browser console,
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
