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
  localUrl: string | null;
  error: string | null;
}

export class HttpReadiness {
  private listenerState: ListenerState = "starting";
  private localUrl: string | null = null;
  private listenerError: string | null = null;
  private publicUrl: string | null = null;
  private publicUrlState: HttpStatus["publicUrlState"] = "resolving";

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
    this.publicUrl = ip ? resolvePublicUrl(this.override, ip, this.port).base : null;
    this.publicUrlState = this.publicUrl ? "ready" : "failed";
    this.changed(this.snapshot());
  }
}
