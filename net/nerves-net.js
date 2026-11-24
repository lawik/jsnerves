/*
 * Network adapters for NervesVM (pass one as the `network` option). The
 * guest gets a virtio-net interface, eth0, and the adapter carries its
 * Ethernet frames somewhere:
 *
 *   wisp(url)           a network that lives in the page (v86's stack):
 *                       DHCP, DNS over HTTPS, NTP and ping are answered in
 *                       the browser, and every TCP connection the guest
 *                       opens is carried to a Wisp server over one
 *                       WebSocket, which makes the real connection.
 *                       Connections into the guest: adapter.connect(port).
 *   ethernet(url)       raw Ethernet frames over a WebSocket to a relay
 *                       that bridges them to a real network (the JSLinux
 *                       "wsproxy" protocol: websockproxy, wsnic, ...).
 *
 *   const net = await import("./net/nerves-net.js");
 *   const vm = new NervesVM({ network: net.wisp("ws://localhost:6001/") });
 */
import { WispNetworkAdapter } from "./v86/browser/wisp_network.js";
import { fake_tcp_connect } from "./v86/browser/fake_network.js";

function macString(frame)
{
    return Array.from(frame.subarray(6, 12),
                      (b) => b.toString(16).padStart(2, "0")).join(":");
}

/* options: router_ip, vm_ip (defaults 192.168.86.1 and .100), dns_method
   ("doh", or "static" to answer 192.168.87.1 for every name), doh_server
   (default cloudflare-dns.com), mtu */
export function wisp(url, options)
{
    let vm = null;
    const handlers = {};
    /* the part of v86's bus the adapter uses */
    const bus = {
        register(name, fn, ctx) { handlers[name] = fn.bind(ctx); },
        send(name, data) {
            if (name === "net0-receive" && vm)
                vm.sendPacket(data);
        },
        pair: { send() {} },
    };
    const adapter = new WispNetworkAdapter(url, bus, options || {});
    let mac = null;

    return {
        adapter: adapter,
        attach(v) {
            vm = v;
            vm.setCarrier(true);
        },
        /* a frame from the guest */
        receive(frame) {
            const src = macString(frame);
            if (src !== mac) {
                /* the emulator picks a random MAC address: learn it */
                mac = src;
                handlers["net0-mac"](mac);
            }
            handlers["net0-send"](frame);
        },
        /* open a TCP connection to a port the guest listens on. The
           connection has on("connect"), on("data", bytes), on("close"),
           write(bytes) and close(). */
        connect(port) {
            return fake_tcp_connect(port, adapter);
        },
        close() {
            adapter.destroy();
        },
    };
}

export function ethernet(url)
{
    let vm = null, ws = null;

    return {
        attach(v) {
            vm = v;
            ws = new WebSocket(url);
            ws.binaryType = "arraybuffer";
            ws.onopen = () => vm.setCarrier(true);
            ws.onclose = () => vm.setCarrier(false);
            ws.onmessage = (e) => {
                if (e.data instanceof ArrayBuffer) {
                    vm.sendPacket(new Uint8Array(e.data));
                } else if (String(e.data).startsWith("ping:")) {
                    ws.send("pong:" + String(e.data).substring(5));
                }
            };
        },
        receive(frame) {
            if (ws && ws.readyState === WebSocket.OPEN)
                ws.send(frame);
        },
        close() {
            if (ws)
                ws.close();
        },
    };
}

/* Make a TCP port of the guest (say 22, for nerves_ssh) reachable through a
   relay server, with a network from wisp(). The page keeps a WebSocket open
   to relayUrl; for every client that connects to the relay, the relay sends
   the text message "open <id>" and the page opens a second WebSocket,
   relayUrl + "/" + id, and joins it to a new connection to the guest's
   port. Returns {close()}. */
export function expose(net, relayUrl, port)
{
    const base = relayUrl.replace(/\/$/, "");
    const control = new WebSocket(base);

    control.onmessage = (e) => {
        const m = /^open (\w+)$/.exec(String(e.data));
        if (!m)
            return;
        const ws = new WebSocket(base + "/" + m[1]);
        const conn = net.connect(port);
        const pending = [];     /* relay -> guest, until connected */
        const toRelay = [];     /* guest -> relay, until the socket opens */
        let open = false;

        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
            for (const data of toRelay)
                ws.send(data);
            toRelay.length = 0;
        };
        ws.onmessage = (ev) => {
            const data = new Uint8Array(ev.data);
            if (open)
                conn.write(data);
            else
                pending.push(data);
        };
        ws.onclose = () => conn.close();
        conn.on("connect", () => {
            open = true;
            for (const data of pending)
                conn.write(data);
            pending.length = 0;
        });
        conn.on("data", (data) => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(data);
            else if (ws.readyState === WebSocket.CONNECTING)
                toRelay.push(new Uint8Array(data));
        });
        conn.on("close", () => ws.close());
    };
    return {
        close() { control.close(); },
    };
}
