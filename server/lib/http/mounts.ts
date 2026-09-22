// mounts.ts — tLib's own mounts on its own router.
//
// These are `kind: 'inprocess'`: the handler is a live function reference, not
// a loopback address. Only tLib itself can register one, and not by policy but
// by construction — every FiveM resource's Node bundle runs in a separate V8
// isolate, so no other resource could hand us a callable anyway.
//
// Realtime lives here. It used to own a second public socket on 0.0.0.0:30125;
// it now shares the router's. Its protocol, session and room layers are
// untouched — only the transport it attaches to changed.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getOrStart } from "../realtime/index";
import { REALTIME_MOUNT } from "./constants";
import type { Log } from "./proxy";
import { register } from "./registry";

export { REALTIME_MOUNT };

export function registerInProcess(log: Log): void {
  const result = register({
    kind: "inprocess",
    id: "realtime",
    mount: REALTIME_MOUNT,
    title: "Realtime",
    // Not a page — there is nothing for a browser to visit here, so it would
    // only be noise on the hub.
    listed: false,
    resourceName: "tLib",
    onUpgrade: (req, socket, head) => {
      // Lazily constructs the session/room machinery on the first actual
      // connection, preserving the old behaviour: a server where nobody uses
      // realtime pays nothing for it beyond one registry entry.
      getOrStart().handleUpgrade(req as IncomingMessage, socket as Duplex, head as Buffer);
    },
  });

  if (!result.ok) {
    log("error", `could not mount realtime at ${REALTIME_MOUNT}: ${result.error}`);
  }
}
