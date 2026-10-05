/**
 * The transport contract shared by every TIMMYG Studios Stream Deck link.
 *
 * ── What is in here, and what deliberately is not ────────────────────────────
 *
 * The LINK is shared; the PAYLOAD is not. Every product's state frame has its
 * own shape — tELS nests its snapshot under `payload`, tRadar sends its fields
 * flat beside a `payload` that is a version NUMBER, tRadio sends them flat
 * beside a `v` — and those three shapes are on the wire between shipped plugins
 * and shipped resources. Unifying them is a protocol migration, not a refactor,
 * so this file does not attempt it.
 *
 * What it does carry is everything that was genuinely identical and had been
 * written out three times: the port allocation, the liveness timings, and the
 * four CONTROL frames (`ping`, `pong`, `bye`, and the `command` envelope), which
 * are byte-compatible across all three products today.
 *
 * ── Why the ports live in a typed record ─────────────────────────────────────
 *
 * The allocation used to exist as a sentence in a comment, repeated in six
 * files, with nothing anywhere able to notice a collision. Two plugins binding
 * one port presents to a player as "the plugin is broken", with the loser's keys
 * blank and no message naming the winner. `DECK_PORTS` plus the distinctness
 * assertion below turns that into a compile error in this file, which is the one
 * place a new product will have to touch to claim a port.
 *
 * This module has NO imports on purpose. It is vendored into three Stream Deck
 * plugins (Node, no DOM lib) and imported by four page bundles (CEF, no Node),
 * so anything it reached for would break one half or the other.
 */

/**
 * Loopback port per product. One server each, so they must not collide.
 *
 * Numbers, once allocated, are frozen: a change here orphans every player whose
 * plugin and resource are not updated in the same breath.
 */
export const DECK_PORTS = {
  tRadio: 21398,
  tRadar: 21399,
  tELS: 21400,
} as const;

/** A product that owns a deck link. */
export type DeckProduct = keyof typeof DECK_PORTS;

/** The port allocated to a given product. */
export type DeckPort = (typeof DECK_PORTS)[DeckProduct];

/**
 * Compile-time proof that no two products share a port.
 *
 * For each product, the union of EVERY OTHER product's port must not contain
 * this one's. When that holds, `Extract<…>` is `never`, the mapped value type is
 * `true`, and the object below checks. The moment two numbers in `DECK_PORTS`
 * are equal, the colliding keys' value type becomes `never`, `true` stops being
 * assignable, and `tsc` fails pointing at the key that collided.
 *
 * This is the whole reason the allocation is a record rather than a comment.
 * Verified in both directions: duplicating a port here is a type error, and
 * the error names the offending product.
 */
type OthersPort<P extends DeckProduct> = (typeof DECK_PORTS)[Exclude<DeckProduct, P>];
type PortsAreDistinct = {
  [P in DeckProduct]: Extract<OthersPort<P>, (typeof DECK_PORTS)[P]> extends never ? true : never;
};
const _portsAreDistinct: PortsAreDistinct = { tRadio: true, tRadar: true, tELS: true };
void _portsAreDistinct;

/**
 * Transport envelope version.
 *
 * Owned by the transport and near-frozen. It is deliberately SEPARATE from
 * whatever version a product stamps on its own payload: coupling them means a
 * payload change forces an envelope bump, and a peer then rejects a build it is
 * entirely compatible with. tRadio has the scar — it spent a `v4` on a pairing
 * handshake, dropped the handshake, and found the wire byte-identical to v3
 * again with the number already burned.
 */
export const ENVELOPE_VERSION = 1;

/**
 * How long the plugin waits for ANY frame from a peer before dropping it.
 *
 * Re-armed by every inbound message and by every pong, so a quiet-but-connected
 * page stays online. Must stay comfortably above `KEEPALIVE_MS` and above
 * `PING_MS`, or a healthy peer races its own watchdog.
 */
export const STALE_MS = 12_000;

/** How often a page sends its application-level keepalive. */
export const KEEPALIVE_MS = 3_000;

/**
 * How often the plugin sends a WebSocket ping frame.
 *
 * This is the layer that survives CEF throttling a backgrounded page's timers:
 * browsers answer ping frames in the network stack whatever the JS event loop is
 * doing. It is why `STALE_MS` can be short without being trigger-happy.
 */
export const PING_MS = 4_000;

/** How long to wait before retrying a bind that hit EADDRINUSE. */
export const REBIND_MS = 3_000;

/**
 * How many binds to attempt before giving up and saying so.
 *
 * Bounded on purpose, and the bound is the point. Retrying forever means a port
 * collision presents as a plugin that simply never appears, with nothing
 * anywhere saying why — which is exactly what tRadio did. Six attempts is ~18s:
 * longer than an orphaned instance takes to exit on reload, short enough that a
 * real collision surfaces while the player is still looking at the deck.
 */
export const DEFAULT_MAX_BIND_ATTEMPTS = 6;

/* ── Control frames ─────────────────────────────────────────────────────────── */

/** Page → plugin. Application-level keepalive. */
export interface PingFrame {
  type: "ping";
  source?: string;
}

/** Page → plugin. Reply to a plugin's application-level ping. */
export interface PongFrame {
  type: "pong";
  source?: string;
}

/** Page → plugin. Sent when a page is unloading or its resource is stopping. */
export interface ByeFrame {
  type: "bye";
  source?: string;
}

/**
 * Page → plugin. A state push.
 *
 * `source` is how one plugin tells two feeds apart (tRadio runs the in-game
 * radio and the dispatch panel at once). Everything else is product-owned, which
 * is why this is an intersection rather than a closed shape.
 */
export type StateFrame<TSnap> = { type: "state"; source?: string } & TSnap;

/** Any frame a page can send a plugin. */
export type InboundFrame<TSnap> = PingFrame | PongFrame | ByeFrame | StateFrame<TSnap>;

/**
 * The recommended envelope for a NEW product.
 *
 * Not retrofitted onto the three that exist — see the header. A product
 * starting today should nest its payload and stamp both numbers, so that a
 * transport change and a payload change can move independently.
 */
export interface Envelope<TSnap> {
  type: "state";
  source: string;
  /** The transport's version: `ENVELOPE_VERSION`. */
  envelope: number;
  /** The product's own payload version, owned and bumped by the product. */
  payload: number;
  /** The snapshot itself. */
  snapshot: TSnap;
}

/** True for the three frames the shared link layer handles by itself. */
export function isControlFrame(msg: { type?: unknown }): boolean {
  return msg.type === "ping" || msg.type === "pong" || msg.type === "bye";
}
