// Runtime readiness is not the advertised address. A TLS proxy may expose 443
// while this listener serves plain HTTP on 7777. Consumers must use localUrl for
// origin health checks, and only advertise a mount after registration succeeds.
import { resolvePublicUrl } from "./public-url";

export type ListenerState = "starting" | "listening" | "failed" | "stopped";
export interface HttpStatus {
  ready: boolean;
  listenerState: ListenerState;
  publicUrlState: "resolving" | "ready" | "failed";
  publicUrl: string | null;
  /**
   * True when `publicUrl` came from IP detection rather than
   * `tlib_http_public_url`.
   *
   * Carried out to consumers because a guessed address and a configured one are
   * different facts to an operator, and the banner is the only place either is
   * seen in time to act. Three tickets in one day on 2026-10-19 were the same
   * shape: the panel is reached by hostname through a proxy, tLib published the
   * detected IP, and the browser's origin stopped matching — which surfaces as
   * a CORS refusal much later, far from the cause. The convar exists for this
   * and was documented only in a code comment and a README table, so operators
   * were searching a config file for a key that no longer exists.
   */
  publicUrlDetected: boolean;
  localUrl: string | null;
  error: string | null;
}

export class HttpReadiness {
  private listenerState: ListenerState = "starting";
  private localUrl: string | null = null;
  private listenerError: string | null = null;
  private publicUrl: string | null = null;
  private publicUrlState: HttpStatus["publicUrlState"] = "resolving";
  // Starts true: until an override is accepted below, any address this ends
  // up publishing is a detected one.
  private publicUrlDetected = true;

  constructor(
    private readonly override: string | null,
    private readonly port: number,
    private readonly changed: (status: HttpStatus) => void
  ) {
    const resolved = resolvePublicUrl(override, null, port);
    // Explicit localhost is supported. Only the implicit/provisional fallback
    // must never escape as an authoritative OAuth or client endpoint.
    if (!resolved.detected) {
      this.publicUrl = resolved.base;
      this.publicUrlState = "ready";
      this.publicUrlDetected = false;
    }
  }

  snapshot(): HttpStatus {
    return {
      ready:
        this.listenerState === "listening" &&
        this.localUrl !== null &&
        this.publicUrlState === "ready",
      listenerState: this.listenerState,
      publicUrlState: this.publicUrlState,
      publicUrl: this.publicUrl,
      publicUrlDetected: this.publicUrlDetected,
      localUrl: this.localUrl,
      error:
        this.listenerError ??
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
    const resolved = ip ? resolvePublicUrl(this.override, ip, this.port) : null;
    this.publicUrl = resolved?.base ?? null;
    this.publicUrlDetected = resolved?.detected ?? true;
    this.publicUrlState = this.publicUrl ? "ready" : "failed";
    this.changed(this.snapshot());
  }
}
