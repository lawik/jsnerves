# v86 network stack

`browser/fake_network.js` and `browser/wisp_network.js` are copied unchanged
from [v86](https://github.com/copy/v86) (commit in `VERSION`, BSD 2-clause
license in `LICENSE`). They terminate the guest's TCP connections in the
browser and answer ARP, DHCP, DNS (over HTTPS), NTP and ping themselves;
`wisp_network.js` carries the TCP streams to a
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) server over one
WebSocket.

`const.js`, `log.js`, `lib.js` and `bus.js` stand in for the v86 modules
they import. `../nerves-net.js` connects them to a NervesVM.
