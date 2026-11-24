// Stand-in for v86's src/log.js. Set globalThis.NERVES_NET_DEBUG = true to
// see the network stack's debug messages in the browser console.
export function dbg_log(msg)
{
    if (globalThis.NERVES_NET_DEBUG)
        console.log("[net] " + msg);
}

export function dbg_assert(cond, msg)
{
    if (!cond)
        throw new Error("assertion failed" + (msg ? ": " + msg : ""));
}
