// Stand-in for v86's src/lib.js: the hex formatter fake_network.js logs with.
export function h(n, len)
{
    const s = n ? n.toString(16) : "0";
    return "0x" + (len ? s.padStart(len, "0") : s).toUpperCase();
}
