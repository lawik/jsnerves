# JSNerves

Nerves running in a web browser: a RISC-V machine emulated by
[TinyEMU](https://bellard.org/tinyemu/) compiled to WebAssembly, booting
OpenSBI, U-Boot and a Nerves firmware image from an A/B disk layout, exactly
as a real device would.

Everything here is static files. Serve the directory and open `index.html`.

## What is served

| File | Role |
| ---- | ---- |
| `index.html`, `style.css`, `term.js`, `jslinux.js` | the page and terminal |
| `riscvemu64-wasm.js`, `riscvemu64-wasm.wasm` | the emulator (built from `../tinyemu`, branch `emscripten-modern`) |
| `nerves.cfg` | VM description: 128 MB RAM, `opensbi.bin` as bios, `u-boot.bin` as kernel, `disk/` as the virtio disk |
| `opensbi.bin` | OpenSBI `fw_jump` from the Nerves system |
| `u-boot.bin` | U-Boot (S-mode, HTIF console, virtio-blk) from the Nerves system |
| `disk/blk*.bin`, `disk/blk.txt` | the fwup-written disk image in 256 KB blocks, fetched on demand. Blocks that are all zeros are not present; the emulator treats a 404 as zeros. `blk.txt` also carries an `id` for the persisted writes |

The disk image holds an MBR, the U-Boot environment with the Nerves
firmware metadata, kernel slots A and B, rootfs partitions A and B and an
f2fs application partition. U-Boot reads `nerves_fw_active` from the
environment and boots that slot. See `fwup_include/fwup-common.conf` in
`../nerves_system_jslinux` for the layout.

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

## Updating the firmware

Build the firmware in `../web-demo-nerves`, then:

```sh
./extract_firmware.sh ../web-demo-nerves/_build/jslinux_dev/nerves/images/web_demo_nerves.fw \
  ../nerves_system_jslinux/.nerves/artifacts/nerves_system_jslinux-portable-*/images
python3 -m http.server 8000
```

`extract_firmware.sh` writes the disk image with `fwup -a -t complete`, splits
it into blocks, drops the empty ones, and copies OpenSBI and U-Boot from the
system's `images/` directory.

## Page parameters

Query parameters on `index.html`: `url=` another `.cfg`, `cols=`/`rows=`
terminal size (default 80x30), `font_size=` (default 17px, shrunk to fit the
viewport), `mem=` RAM in MB, `reset=1` to discard the persisted disk.

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
