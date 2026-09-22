// The engine registry: who is already serving what, on this server, right now.
//
// Resources that ship local inference — tAI, tRadio — each work alone, which
// means each is prepared to load its own model. Installed together on one box
// that is two copies of the same multi-gigabyte weights in memory for no gain.
// This is the bookkeeping that lets the second one find the first.
//
// Control plane only. No inference passes through here and no bytes are proxied:
// an advertisement is a note saying "capability C, artifact W, reachable at U",
// and the consumer then talks to U directly. That is what keeps this generic
// enough to live in tLib without tLib knowing anything about models.
//
// Two rules are enforced rather than documented:
//
//   Loopback only. An advertised URL that is not on 127.0.0.1 is rejected, so
//   no resource can use the registry to publish an unauthenticated model
//   endpoint to the network under another resource's name.
//
//   Workload identity, not paths. Matching is on the artifact identity the
//   advertiser declares, so the same weights shipped in two resources' own
//   directories match, and two genuinely different models do not — the operator
//   who installed different weights gets the two engines they asked for.

export interface Advertisement {
  handle: string;
  /** The resource that advertised it, as the runtime reported it. */
  resource: string;
  capability: string;
  /** Artifact identity: what is loaded, not where it came from. */
  workload: string;
  /**
   * The full URL the capability is served at, route included.
   *
   * A full URL rather than a base, because not every engine is OpenAI-shaped —
   * whisper.cpp serves `/inference` and has no `/v1/audio/transcriptions` — and
   * a consumer that has to guess the route has to know what it is talking to.
   */
  url: string;
  /** Model name to send on the route. Local servers serve one and ignore it. */
  model: string;
  at: number;
}

export interface AdvertiseRequest {
  capability?: unknown;
  workload?: unknown;
  url?: unknown;
  model?: unknown;
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?(\/|$)/i;

export class Registry {
  private readonly live = new Map<string, Advertisement>();
  private next = 1;

  /**
   * The boot id handles are stamped with.
   *
   * A handle from before a tLib restart names an epoch that no longer exists, so
   * it cannot withdraw an advertisement the new registry made under the same
   * counter value.
   */
  readonly epoch = Math.floor(Math.random() * 0xffffff).toString(36);

  advertise(resource: string, request: AdvertiseRequest): string {
    const capability = short(request.capability, 32);
    const workload = short(request.workload, 128);
    const url = short(request.url, 256).replace(/\/+$/, "");
    if (!resource || !capability || !workload || !url) return "";
    if (!LOOPBACK.test(url)) return "";

    // Re-advertising the same workload replaces rather than duplicates: a
    // resource restarting its engine on a new port should not leave the old one
    // in the table for the next consumer to time out against.
    for (const [handle, entry] of this.live) {
      if (entry.resource === resource && entry.capability === capability) this.live.delete(handle);
    }

    const handle = `${this.epoch}:${this.next++}`;
    this.live.set(handle, {
      handle,
      resource,
      capability,
      workload,
      url,
      model: short(request.model, 128),
      at: Date.now(),
    });
    return handle;
  }

  /**
   * An engine someone else is already running for this exact workload.
   *
   * The caller's own advertisement is skipped, because a resource finding itself
   * would read as "someone else has this covered" and leave nothing running.
   */
  lookup(resource: string, capability: string, workload: string): Advertisement | null {
    for (const entry of this.live.values()) {
      if (entry.resource === resource) continue;
      if (entry.capability === capability && entry.workload === workload) return entry;
    }
    return null;
  }

  withdraw(resource: string, handle: string): boolean {
    const entry = this.live.get(handle);
    if (!entry || entry.resource !== resource) return false;
    this.live.delete(handle);
    return true;
  }

  /** Everything a stopping resource left behind. */
  withdrawAll(resource: string): number {
    let removed = 0;
    for (const [handle, entry] of this.live) {
      if (entry.resource !== resource) continue;
      this.live.delete(handle);
      removed++;
    }
    return removed;
  }

  list(): Advertisement[] {
    return [...this.live.values()];
  }
}

function short(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
