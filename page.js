/*
 * The JSNerves page: a terminal and a few status lines on top of
 * nerves-vm.js. Everything shown here comes from the NervesVM's events.
 *
 * Parts (get_params, the terminal glue) come from JSLinux:
 * Copyright (c) 2017 Fabrice Bellard
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
"use strict";

function get_params()
{
    var query_str, p, tab, i, params, tab2;
    query_str = window.location.href;
    p = query_str.indexOf("?");
    if (p < 0)
        return {};
    query_str = query_str.substr(p + 1);
    tab = query_str.split("&");
    params = {};
    for(i = 0; i < tab.length; i++) {
        tab2 = tab[i].split("=");
        params[decodeURIComponent(tab2[0])] = decodeURIComponent(tab2[1]);
    }
    return params;
}

function format_bytes(n)
{
    if (n >= 1048576)
        return (n / 1048576).toFixed(1) + " MB";
    return Math.round(n / 1024) + " KB";
}

function format_seconds(s)
{
    if (s < 10)
        return s.toFixed(1) + " s";
    if (s < 90)
        return Math.round(s) + " s";
    return Math.round(s / 60) + " min";
}

/* Shrink the terminal font so the whole console (and whatever is stacked
   around it in #term_wrap) stays inside the viewport. The terminal is sized
   in em/ch units, so scaling the font scales the box. */
function fit_terminal(el, base_size)
{
    var wrap = el.parentElement.parentElement || el.parentElement;
    var cs = getComputedStyle(document.body);
    var pad_x = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    var pad_y = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var avail_w = document.documentElement.clientWidth - pad_x;
    var avail_h = window.innerHeight - pad_y;
    var size = base_size, i, r, wr, extra_h, scale;

    el.style.fontSize = size + "px";
    for(i = 0; i < 3; i++) {
        r = el.getBoundingClientRect();
        wr = wrap.getBoundingClientRect();
        extra_h = Math.max(0, wr.height - r.height); /* status lines, gaps */
        scale = Math.min(1, avail_w / r.width, (avail_h - extra_h) / r.height);
        if (scale >= 0.995)
            break;
        size = Math.max(1, Math.floor(size * scale * 10) / 10);
        el.style.fontSize = size + "px";
    }
}

/* Phones only show a keyboard when an editable element has focus, and
   their IMEs mostly deliver text through "input" events (keydown arrives
   as keyCode 229), which term.js does not listen for. Keep a hidden
   textarea focused and turn changes to its value into terminal input.
   On desktop term.js preventDefault()s the key events, so the textarea
   never changes and nothing is sent twice. */
function setup_soft_keyboard(term, ta)
{
    var prev = "";

    function send(str)
    {
        if (term.utf8)
            str = term.to_utf8(str);
        term.show_cursor();
        term.handler(str);
    }

    function focus()
    {
        if (document.activeElement !== ta)
            ta.focus({ preventScroll: true });
    }

    ta.addEventListener("input", function() {
        var cur = ta.value, i, n, nl;
        /* Enter: send what is on the line, then CR, and start over */
        nl = cur.indexOf("\n");
        if (nl >= 0) {
            cur = cur.replace(/\n/g, "");
            ta.value = "";
        }
        n = Math.min(prev.length, cur.length);
        for(i = 0; i < n && prev.charCodeAt(i) == cur.charCodeAt(i); i++)
            ;
        if (prev.length > i)
            send("\x7f".repeat(prev.length - i));
        if (cur.length > i)
            send(cur.substring(i));
        if (nl >= 0) {
            send("\r");
            prev = "";
            ta.value = "";
        } else {
            prev = cur;
        }
    });

    /* Don't let the buffer grow forever: forget the line on space/word
       boundaries once it's safely out of IME composition range. */
    ta.addEventListener("compositionend", function() {
        if (ta.value.length > 64) {
            ta.value = "";
            prev = "";
        }
    });

    /* the page is nothing but the console, so any tap or click means
       "type here" */
    document.addEventListener("click", focus);
    document.addEventListener("touchend", focus, { passive: true });
    window.addEventListener("pageshow", focus);
    focus();
}

/* ?wisp=ws://host:port/ gives the guest a network through a Wisp server,
   ?ethernet=ws://host:port/ through an Ethernet relay (net/nerves-net.js).
   With wisp, ?expose=ws://host:port/ makes the guest's port 22 (or
   ?expose_port=) reachable through a relay (see expose()). */
function network(params)
{
    if (!params["wisp"] && !params["ethernet"])
        return Promise.resolve(null);
    return import("./net/nerves-net.js").then(function(net) {
        var adapter;
        if (!params["wisp"])
            return net.ethernet(params["ethernet"]);
        adapter = net.wisp(params["wisp"]);
        /* ?expose=ws://relay/: the guest's SSH port through a relay */
        if (params["expose"])
            net.expose(adapter, params["expose"], (params["expose_port"] | 0) || 22);
        return adapter;
    });
}

(function() {
    var params = get_params();
    var cols = (params["cols"] | 0) || 80;
    var rows = (params["rows"] | 0) || 30;
    var font_size = (params["font_size"] | 0) || 17;
    var reset_url = window.location.pathname + "?reset=1";
    var term, vm;

    var bar = document.querySelector("#image_progress .loader_bar");
    var image_label = document.querySelector("#image_progress .loader_label");
    var stage_el = document.getElementById("boot_stage");
    var disk_el = document.getElementById("disk_status");

    vm = new NervesVM({
        config: params["url"] || "nerves.cfg",
        memory: (params["mem"] | 0) || 128,
        cmdline: params["cmdline"] || "",
        cols: cols,
        rows: rows,
        resetDisk: !!(params["reset"] | 0),
    });
    window.nervesVM = vm; /* for the console and for tests */

    term = new Term(cols, rows, function(str) { vm.write(str); }, 10000);
    term.open(document.getElementById("term_container"),
              document.getElementById("term_input"));
    setup_soft_keyboard(term, document.getElementById("term_input"));
    term.term_el.style.fontSize = font_size + "px";
    fit_terminal(term.term_el, font_size);
    window.addEventListener("resize", function() {
        fit_terminal(term.term_el, font_size);
    });

    vm.addEventListener("console", function(e) {
        term.write(e.detail.data);
    });

    vm.addEventListener("progress", function(e) {
        var p = e.detail, text;
        bar.style.width = p.percent.toFixed(1) + "%";
        if (p.done) {
            text = "disk image " + format_bytes(p.total) + " loaded in " +
                format_seconds(p.elapsed) + " (" +
                format_bytes(p.bytesPerSecond) + "/s)";
        } else {
            text = "disk image " + format_bytes(p.loaded) + " of " +
                format_bytes(p.total) + " · " + Math.floor(p.percent) + "%";
            if (p.bytesPerSecond !== null)
                text += " · " + format_bytes(p.bytesPerSecond) + "/s";
            if (p.secondsLeft !== null)
                text += " · " + format_seconds(p.secondsLeft) + " left";
        }
        image_label.textContent = text;
    });

    vm.addEventListener("stage", function(e) {
        var s = e.detail, text;
        switch (s.stage) {
        case "ready":
            text = "IEx is ready, " + format_seconds(s.sinceBoot / 1000) +
                " after power on" + (s.slot ? " (slot " + s.slot + ")" : "");
            break;
        case "reset":
            text = "rebooting";
            break;
        case "off":
            text = "powered off";
            break;
        default:
            text = "booting: " + s.label + " at " +
                format_seconds(s.sinceBoot / 1000) +
                (s.slot ? " (slot " + s.slot + ")" : "");
            break;
        }
        stage_el.textContent = text;
    });

    vm.addEventListener("disk", function(e) {
        var d = e.detail, text;
        switch (d.status) {
        case "on":
            text = "disk changes stay in this browser";
            if (d.savedBytes > 0)
                text += " (" + format_bytes(d.savedBytes) + ")";
            disk_el.innerHTML = text + ' &middot; <a href="' + reset_url + '">reset disk</a>';
            break;
        case "error":
            disk_el.innerHTML = 'could not save disk changes &middot; <a href="' + reset_url + '">reset disk</a>';
            break;
        default:
            disk_el.textContent = "disk changes are lost when the page closes";
            break;
        }
    });

    vm.addEventListener("poweroff", function() {
        term.write("\r\n\x1b[1m[ The machine is off. Reload the page to boot it again. ]\x1b[0m\r\n");
    });

    vm.addEventListener("error", function(e) {
        stage_el.textContent = "error: " + e.detail.message;
    });

    /* ?debug=1: the console log and the boot stages in the browser console */
    if (params["debug"] | 0) {
        vm.addEventListener("line", function(e) {
            console.log("[nerves] " + e.detail.text);
        });
        vm.addEventListener("stage", function(e) {
            console.log("[nerves] stage " + e.detail.stage + " at " +
                        Math.round(e.detail.sinceBoot) + " ms");
        });
    }

    term.write("Loading...\r\n");
    network(params).then(function(net) {
        vm.options.network = net;
        window.nervesNet = net;
        return vm.start();
    }).then(function() {
        /* a ?reset=1 reload would reset the disk again */
        if ((params["reset"] | 0) && window.history && history.replaceState)
            history.replaceState(null, "", window.location.pathname);
    });
})();
