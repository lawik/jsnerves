/*
 * nerves-vm.js: run the Nerves machine (TinyEMU compiled to WebAssembly)
 * in a page and report what it does as DOM events.
 *
 *   const vm = new NervesVM({ config: "nerves.cfg" });
 *   vm.addEventListener("console", (e) => term.write(e.detail.data));
 *   vm.addEventListener("progress", (e) => show(e.detail.percent));
 *   vm.start();
 *
 * Events (all CustomEvents, the payload is in event.detail):
 *
 *   console   {data}            raw console output, escape sequences and
 *                               all, for a terminal
 *   line      {text, time}      one console line without escape sequences;
 *                               the last lines are kept in vm.log
 *   stage     {stage, label, previous, time, sinceBoot, slot}
 *                               boot progress: loading, opensbi, uboot,
 *                               linux, init, erlang, ready; reset when the
 *                               guest reboots, off when it powers off
 *   progress  {loaded, total, percent, bytesPerSecond, secondsLeft,
 *              blocksLoaded, blocksTotal, elapsed, done}
 *                               download of the disk image: every block
 *                               that is not all zeros, whether the guest
 *                               asked for it or it was prefetched
 *   disk      {status, savedBytes, restoredBytes}
 *                               disk persistence in IndexedDB ("on",
 *                               "off" or "error")
 *   reset     {}                the guest rebooted; the machine starts over
 *   poweroff  {status}          the guest powered off; the machine stopped
 *   error     {message}         something went wrong loading the machine
 *
 * The emulator keeps its state in globals (Module), so there can be one
 * NervesVM per page.
 */
"use strict";

(function(global) {

const DISK_DB = "tinyemu-disk"; /* see js/lib.js in tinyemu */

const STAGES = [
    { stage: "opensbi", label: "OpenSBI", match: /^OpenSBI v\d/ },
    { stage: "uboot", label: "U-Boot", match: /^U-Boot \d{4}\.\d+/ },
    { stage: "linux", label: "Linux", match: /^Starting kernel|Linux version \d/ },
    { stage: "init", label: "erlinit", match: /Run \/sbin\/init as init process/ },
    { stage: "erlang", label: "Erlang", match: /^Erlang\/OTP \d+/ },
    { stage: "ready", label: "IEx", match: /^iex\(\d+\)> ?$/, prompt: true },
];
const LABELS = { idle: "Not started", loading: "Loading the emulator",
                 reset: "Rebooting", off: "Powered off" };
STAGES.forEach(function(s) { LABELS[s.stage] = s.label; });

/* CSI, OSC and the other escape sequences a console prints */
const ESCAPES = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()#][0-9A-Za-z]|[0-9=<>@-Z\\^_`a-z~])/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

function plain(str)
{
    return str.replace(ESCAPES, "").replace(CONTROLS, "");
}

const SPEED_WINDOW_MS = 3000;   /* download speed over the last 3 s */
const PROGRESS_EVERY_MS = 100;  /* at most 10 progress events a second */

class NervesVM extends EventTarget {
    constructor(options) {
        super();
        this.options = Object.assign({
            config: "nerves.cfg",          /* VM configuration file */
            emulator: "riscvemu64-wasm.js", /* emscripten output */
            memory: 128,                   /* MB */
            cols: 80,
            rows: 30,
            cmdline: "",
            resetDisk: false,              /* drop the persisted disk first */
            logLines: 2000,                /* lines kept in vm.log */
            network: null,                 /* see attachNetwork() */
        }, options || {});
        this.stage = "idle";
        this.slot = null;       /* firmware slot U-Boot booted */
        this.log = [];          /* [{time, text}] */
        this.progress = null;   /* last progress payload */
        this.disk = { status: "off", savedBytes: 0, restoredBytes: 0 };
        this._line = "";
        this._stageIndex = -1;
        this._t0 = 0;
        this._bootT0 = 0;
        this._image = null;
        this._queueChar = null;
        this._network = null;
    }

    /* Load the emulator and boot. Resolves once the machine is running. */
    async start() {
        if (NervesVM._instance)
            throw new Error("NervesVM: only one machine per page");
        NervesVM._instance = this;
        this._t0 = this._bootT0 = performance.now();
        this._setStage("loading");

        if (this.options.resetDisk)
            await NervesVM.resetDisk();

        const vm = this;
        const ready = new Promise(function(resolve) {
            global.Module = {
                onRuntimeInitialized: function() {
                    vm._boot();
                    resolve();
                },
                onConsoleOutput: function(str) { vm._consoleOutput(str); },
                getConsoleSize: function() {
                    return [vm.options.cols, vm.options.rows];
                },
                onFetch: function(ev) { vm._fetch(ev); },
                onDiskInfo: function(info) { vm._diskInfo(info); },
                onDiskPersist: function(info) { vm._diskPersist(info); },
                onNetPacket: function(bytes) {
                    if (vm._network)
                        vm._network.receive(bytes);
                },
                onReset: function() { vm._reset(); },
                onPowerOff: function(status) { vm._powerOff(status); },
                printErr: function(text) {
                    console.error("[emulator] " + text);
                },
            };
        });
        try {
            await loadScript(new URL(this.options.emulator, document.baseURI).href);
        } catch (e) {
            this._emit("error", { message: "could not load " + this.options.emulator });
            throw e;
        }
        await ready;
    }

    /* Type into the console (a string of byte values, as a terminal sends) */
    write(str) {
        if (!this._queueChar)
            return;
        for (let i = 0; i < str.length; i++)
            this._queueChar(str.charCodeAt(i) & 0xff);
    }

    /* Throw away the disk writes saved in this browser. Use before start(),
       or reload the page afterwards. */
    static resetDisk() {
        return new Promise(function(resolve) {
            let req;
            if (typeof indexedDB == "undefined")
                return resolve();
            try {
                req = indexedDB.deleteDatabase(DISK_DB);
            } catch (e) {
                return resolve();
            }
            req.onsuccess = req.onerror = req.onblocked = function() { resolve(); };
        });
    }

    /* A network adapter is an object with receive(frame): it gets every
       Ethernet frame the guest sends, and gives frames to the guest with
       vm.sendPacket(frame). Pass it as options.network so the guest sees a
       network interface. */
    sendPacket(frame) {
        const M = global.Module;
        const buf = M._malloc(frame.length);
        M.HEAPU8.set(frame, buf);
        M._net_write_packet(buf, frame.length);
        M._free(buf);
    }

    setCarrier(up) {
        global.Module._net_set_carrier(up ? 1 : 0);
    }

    /* internals */

    _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    _now() {
        return performance.now() - this._t0;
    }

    _boot() {
        const M = global.Module;
        const url = new URL(this.options.config, document.baseURI).href;
        const net = this.options.network;
        this._queueChar = M.cwrap("console_queue_char", null, ["number"]);
        M.ccall("vm_start", null,
                ["string", "number", "string", "string", "number", "number", "number"],
                [url, this.options.memory, this.options.cmdline, null, 0, 0, net ? 1 : 0]);
        if (net) {
            this._network = net;
            if (net.attach)
                net.attach(this);
        }
    }

    _setStage(stage, extra) {
        const previous = this.stage;
        const now = this._now();
        this.stage = stage;
        this._emit("stage", Object.assign({
            stage: stage,
            label: LABELS[stage] || stage,
            previous: previous,
            time: now,
            sinceBoot: performance.now() - this._bootT0,
            slot: this.slot,
        }, extra || {}));
    }

    _consoleOutput(str) {
        let nl, line;
        this._emit("console", { data: str });
        this._line += str;
        while ((nl = this._line.indexOf("\n")) >= 0) {
            line = plain(this._line.substring(0, nl));
            this._line = this._line.substring(nl + 1);
            this._addLine(line);
        }
        /* a prompt does not end with a newline */
        if (this._line.length > 0 && this._line.length < 256)
            this._matchStage(plain(this._line), true);
    }

    _addLine(text) {
        const entry = { time: this._now(), text: text };
        this.log.push(entry);
        if (this.log.length > this.options.logLines)
            this.log.splice(0, this.log.length - this.options.logLines);
        this._emit("line", entry);
        const m = /^Booting Nerves slot (\w+)/.exec(text);
        if (m)
            this.slot = m[1];
        this._matchStage(text, false);
    }

    _matchStage(text, partial) {
        for (let i = this._stageIndex + 1; i < STAGES.length; i++) {
            const s = STAGES[i];
            if (partial && !s.prompt)
                continue;
            if (s.match.test(text)) {
                this._stageIndex = i;
                this._setStage(s.stage);
                return;
            }
        }
    }

    _reset() {
        this._stageIndex = -1;
        this._bootT0 = performance.now();
        this.slot = null;
        this._emit("reset", {});
        this._setStage("reset");
    }

    _powerOff(status) {
        this._emit("poweroff", { status: status });
        this._setStage("off");
    }

    _diskPersist(info) {
        this.disk = { status: info.status, savedBytes: info.saved_bytes,
                      restoredBytes: info.restored_bytes };
        this._emit("disk", this.disk);
    }

    /* disk image download */

    _diskInfo(info) {
        this._image = {
            prefix: info.url,
            blockBytes: info.blockBytes,
            blocksTotal: info.blocks - info.zeroBlocks,
            done: new Set(),
            doneBytes: 0,
            inFlight: new Map(),   /* request id -> {block, loaded} */
            samples: [],
            start: performance.now(),
            timer: null,
            lastEmit: 0,
            finished: false,
        };
        this._updateProgress(true);
    }

    _fetch(ev) {
        const img = this._image;
        let m, r;
        if (!img || ev.url.indexOf(img.prefix) != 0)
            return;
        m = /blk(\d+)\.bin$/.exec(ev.url);
        if (!m)
            return;
        switch (ev.phase) {
        case "start":
            img.inFlight.set(ev.id, { block: m[1] | 0, loaded: 0 });
            return;
        case "progress":
            r = img.inFlight.get(ev.id);
            if (r)
                r.loaded = ev.loaded;
            break;
        case "done":
        case "error":
            r = img.inFlight.get(ev.id);
            img.inFlight.delete(ev.id);
            /* a 404 is a block of zeros that blk.txt did not list: it is
               part of the image all the same */
            if (r && !img.done.has(r.block) &&
                (ev.phase == "done" || ev.status == 404)) {
                img.done.add(r.block);
                img.doneBytes += img.blockBytes;
            } else if (ev.phase == "error") {
                this._emit("error", { message: "could not load " + ev.url +
                                      " (HTTP " + ev.status + ")" });
            }
            break;
        }
        this._updateProgress(false);
    }

    _updateProgress(force) {
        const img = this._image;
        const now = performance.now();
        let loaded = img.doneBytes, total, rate = null, left = null, s0, p;

        img.inFlight.forEach(function(r) {
            if (!img.done.has(r.block))
                loaded += Math.min(r.loaded, img.blockBytes);
        });
        total = img.blocksTotal * img.blockBytes;
        loaded = Math.min(loaded, total);

        img.samples.push([now, loaded]);
        while (img.samples.length > 2 && now - img.samples[1][0] >= SPEED_WINDOW_MS)
            img.samples.shift();
        s0 = img.samples[0];
        if (now - s0[0] >= 200)
            rate = (loaded - s0[1]) * 1000 / (now - s0[0]);
        if (rate && rate > 0)
            left = (total - loaded) / rate;

        p = {
            loaded: loaded,
            total: total,
            percent: total > 0 ? 100 * loaded / total : 100,
            bytesPerSecond: rate,
            secondsLeft: left,
            blocksLoaded: img.done.size,
            blocksTotal: img.blocksTotal,
            elapsed: (now - img.start) / 1000,
            done: img.done.size >= img.blocksTotal,
        };
        if (img.finished)
            return;
        this.progress = p;
        if (p.done) {
            img.finished = true;
            p.secondsLeft = 0;
            p.bytesPerSecond = loaded * 1000 / Math.max(1, now - img.start);
        }
        if (img.timer !== null) {
            clearTimeout(img.timer);
            img.timer = null;
        }
        if (force || p.done || now - img.lastEmit >= PROGRESS_EVERY_MS) {
            img.lastEmit = now;
            this._emit("progress", p);
        } else {
            /* deliver the latest numbers even if nothing else arrives */
            const vm = this;
            img.timer = setTimeout(function() {
                img.timer = null;
                img.lastEmit = performance.now();
                vm._emit("progress", vm.progress);
            }, PROGRESS_EVERY_MS - (now - img.lastEmit));
        }
    }
}

function loadScript(src)
{
    return new Promise(function(resolve, reject) {
        const script = document.createElement("script");
        script.src = src;
        script.onload = function() { resolve(); };
        script.onerror = function() { reject(new Error("could not load " + src)); };
        document.head.appendChild(script);
    });
}

NervesVM.STAGES = ["loading"].concat(STAGES.map(function(s) { return s.stage; }));
NervesVM.plain = plain;
global.NervesVM = NervesVM;

})(window);
