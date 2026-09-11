// constants.ts — shared literals with NO imports.
//
// Deliberately dependency-free. mounts.ts imports realtime/index, and
// realtime/config needs the realtime mount path to compose its public URL;
// putting the constant here keeps that from forming an import cycle
// (mounts -> realtime/index -> realtime/config -> mounts), which CommonJS
// resolves by handing one of the modules a half-initialised namespace.

/** Path the realtime WebSocket is mounted at on the router. */
export const REALTIME_MOUNT = "/rt";
