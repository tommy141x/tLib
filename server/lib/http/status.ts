// Runtime readiness is not the advertised address. A TLS proxy may expose 443
// while this listener serves plain HTTP on 7777. Consumers must use localUrl for
// origin health checks, and only advertise a mount after registration succeeds.
//
// localUrl is null whenever no listener binds, which is the default — there is
// then no origin of tLib's to probe, and a consumer must skip the probe rather
// than substitute a guess.
import { resolvePublicUrl } from "./public-url";

/**
 * "disabled" is a listener that was never asked for, and it is a state of its
 * own because the alternatives both lie: "starting" says one is coming, and
 * "stopped" says one went away. Consumers print this state to operators, so a
 * default install would otherwise send somebody to debug a socket that is
 * absent on purpose.
 */
export type ListenerState = "disabled" | "starting" | "listening" | "failed" | "stopped";

/**
 * Which door an address handed to a consumer must be built for.
 *
 * "listener" is tLib's own port, where mounts answer at their registry path.
 * "ingress" is the FiveM server port, where every app answers under its owning
 * resource instead — a different path for the same mount, which is why this is
 * carried out rather than left for a consumer to infer from `listenerState`.
 * null means nothing serves, and no address can be published at all.
 */
export type HttpDoor = "listener" | "ingress" | null;

export interface HttpStatus {
  ready: boolean;
  door: HttpDoor;
  listenerState: ListenerState;
  publicUrlState: "resolving" | "ready" | "failed";
  publicUrl: string | null;
  /**
   * True when `publicUrl` came from IP detection rather than
   * `tlib_http_public_url`.
   *
   * Carried out to consumers because a guessed address and a configured one
   * are different facts to an operator, and the banner is the only place
   * either is seen in time to act — a wrong guess surfaces as a CORS refusal
   * much later, far from the cause, when the panel is reached by hostname
   * through a proxy while tLib published a detected IP instead.
   */
  publicUrlDetected: boolean;
  localUrl: string | null;
  error: string | null;
}

export class HttpReadiness {
  private listenerState: ListenerState;
  private localUrl: string | null = null;
  private listenerError: string | null = null;
  private publicUrl: string | null = null;
  private publicUrlState: HttpStatus["publicUrlState"] = "resolving";
  // Starts true: until an override is accepted below, any address this ends
  // up publishing is a detected one.
  private publicUrlDetected = true;

  /**
   * `port` is the port the published address carries, which is the listener's
   * when one is configured and the FiveM server port when none is.
   *
   * `doors.listener` is whether a listener is configured at all, not whether it
   * is up yet. `doors.ingress` is false only when an operator turned the
   * FiveM-server-port door off with `tlib_http_ingress`.
   */
  constructor(
    private readonly override: string | null,
    /**
     * A FUNCTION, not a number. When no listener binds, the published port is
     * the FiveM server port, and `netPort` is NOT populated when a resource's
     * bundle loads — it reads as "0" until FXServer fills it later in boot.
     * Capturing a number here published `http://<host>:0`, and 0 is finite so
     * nothing caught it. Called at each resolve instead, by which time the
     * server is up. Returns null while the port is still unknowable.
     */
    private readonly port: () => number | null,
    private readonly changed: (status: HttpStatus) => void,
    private readonly doors = { listener: true, ingress: true }
  ) {
    this.listenerState = doors.listener ? "starting" : "disabled";
    const initialPort = port();
    const resolved = initialPort === null ? null : resolvePublicUrl(override, null, initialPort);
    // Explicit localhost is supported. Only the implicit/provisional fallback
    // must never escape as an authoritative OAuth or client endpoint.
    if (resolved && !resolved.detected) {
      this.publicUrl = resolved.base;
      this.publicUrlState = "ready";
      this.publicUrlDetected = false;
    }
  }

  /**
   * A configured listener is the ONLY door publication uses, even though the
   * ingress is also serving: `publicUrl` carries the listener's port, so an
   * ingress path hung off the same base would name that port with the ingress's
   * path and reach nothing. A server that binds therefore publishes exactly the
   * addresses it always did, including refusing while the bind is outstanding.
   */
  private door(): HttpDoor {
    // A stopped lifetime has no door of either kind: the ingress handler is an
    // export of this resource and goes away with it.
    if (this.listenerState === "stopped") return null;
    // `disabled` is authoritative over how the listener was CONFIGURED: it is
    // set at construction when no port was given, and also at runtime when the
    // configured port turns out to be the FiveM server port, which cannot be
    // bound twice and needs no second listener. Either way there is no socket,
    // so the ingress is the door.
    if (this.doors.listener && this.listenerState !== "disabled") {
      return this.listenerState === "listening" && this.localUrl !== null ? "listener" : null;
    }
    return this.doors.ingress ? "ingress" : null;
  }

  snapshot(): HttpStatus {
    const door = this.door();
    return {
      // Readiness is a door plus an address to name it with, not a socket: with
      // no listener there is no socket to wait for and the ingress already
      // serves, so waiting for one would never end.
      ready: door !== null && this.publicUrlState === "ready",
      door,
      listenerState: this.listenerState,
      publicUrlState: this.publicUrlState,
      publicUrl: this.publicUrl,
      publicUrlDetected: this.publicUrlDetected,
      localUrl: this.localUrl,
      error:
        this.listenerError ??
        (!this.doors.listener && !this.doors.ingress
          ? "No HTTP door is open: set tlib_http_port to bind a listener, or drop 'tlib_http_ingress false' to serve on the FiveM server port"
          : null) ??
        (this.publicUrlState === "failed"
          ? "Public address unavailable; set tlib_http_public_url to your reachable address"
          : null),
    };
  }

  listener(
    state: ListenerState,
    localUrl: string | null = null,
    error: string | null = null
  ): void {
    this.listenerState = state;
    this.localUrl = state === "listening" ? localUrl : null;
    this.listenerError = error;
    this.changed(this.snapshot());
  }

  resolveAddress(ip: string | null): void {
    // A late discovery result from a stopped lifetime must not notify consumers
    // or resurrect publication after tLib has been restarted.
    if (this.listenerState === "stopped" || this.publicUrlState === "ready") return;
    const livePort = this.port();
    const resolved = ip && livePort !== null ? resolvePublicUrl(this.override, ip, livePort) : null;
    this.publicUrl = resolved?.base ?? null;
    this.publicUrlDetected = resolved?.detected ?? true;
    this.publicUrlState = this.publicUrl ? "ready" : "failed";
    this.changed(this.snapshot());
  }
}
