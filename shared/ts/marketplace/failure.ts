/**
 * Why a marketplace read failed, in a vocabulary the panel can explain.
 *
 * The server bundle classifies (it holds the real error); Lua carries the kind
 * across unchanged; the NUI picks the wording. A plain string used to cross that
 * whole path, so a 404 from a host that was mid-deploy and a refused TCP connection
 * both reached the player as `Failed to load marketplace` plus whatever Node's
 * message happened to be, usually `fetch failed`.
 *
 * Pure and free of Node imports: the NUI bundle uses the kind list.
 */

export const MARKETPLACE_FAILURE_KINDS = [
  /** The host answered 404. For a list, a route that is not there; an empty catalogue answers 200. */
  "not_found",
  /** 401/403: the host refused this server's credential. */
  "unauthorized",
  /** 429. */
  "rate_limited",
  /** 5xx, including the host's own "not configured" 503. */
  "unavailable",
  /** No answer inside the time limit. */
  "timeout",
  /** No connection at all: DNS, refused, reset, TLS. */
  "unreachable",
  /** The host answered 2xx with something that is not the contract. */
  "bad_response",
  /** tLib's own server side is not serving the marketplace exports. */
  "bridge",
  /** The player lacks the `tlib.admin` ACE. */
  "denied",
  /** Too many reads in flight from this player. */
  "busy",
  /** The panel abandoned the request. */
  "cancelled",
  /** Anything else. */
  "error",
] as const;

export type MarketplaceFailureKind = (typeof MARKETPLACE_FAILURE_KINDS)[number];

export interface MarketplaceFailure {
  kind: MarketplaceFailureKind;
  /** The short technical line, for the detail row and the server log. */
  message: string;
}

/** A kind that arrived over the wire, which may be absent or from a newer tLib. */
export function asFailureKind(value: unknown): MarketplaceFailureKind {
  return (MARKETPLACE_FAILURE_KINDS as readonly unknown[]).includes(value)
    ? (value as MarketplaceFailureKind)
    : "error";
}

interface Coded {
  status: number;
  code: string;
  message: string;
}

// `CatalogueError` (shared) and `MarketplaceError` (server) are two classes for
// one envelope, so this reads the shape rather than naming either.
function isCoded(e: unknown): e is Coded {
  return (
    e instanceof Error &&
    typeof (e as { status?: unknown }).status === "number" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

export function classifyMarketplaceFailure(e: unknown): MarketplaceFailure {
  if (isCoded(e)) {
    return { kind: kindOfStatus(e), message: e.message };
  }
  if (e instanceof Error) {
    // undici reports every transport failure as `TypeError: fetch failed` and puts
    // the useful part (`ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`...) on `cause`.
    const cause = (e as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    if (code || (e instanceof TypeError && e.message === "fetch failed")) {
      return {
        kind: "unreachable",
        message: `could not reach the marketplace host (${code ?? "fetch failed"})`,
      };
    }
    return { kind: "error", message: e.message };
  }
  return { kind: "error", message: String(e) };
}

function kindOfStatus(e: Coded): MarketplaceFailureKind {
  if (e.code === "request_timed_out") return "timeout";
  if (e.code === "unexpected_response") return "bad_response";
  if (e.status === 404) return "not_found";
  if (e.status === 401 || e.status === 403) return "unauthorized";
  if (e.status === 429) return "rate_limited";
  if (e.status >= 500) return "unavailable";
  return "error";
}

export interface FailureCopy {
  title: string;
  /** What it means and what to do, written for the server admin looking at the panel. */
  advice: string;
}

const REASSURE = "Nothing you have installed is affected.";

export const FAILURE_COPY: Record<MarketplaceFailureKind, FailureCopy> = {
  not_found: {
    title: "The marketplace could not find its catalogue",
    advice: `It answered "not found" for this list. An empty catalogue is shown as an empty list instead, so this usually means the marketplace website is being updated, or tlib_api_base_url points somewhere else. ${REASSURE} Try again in a few minutes.`,
  },
  unauthorized: {
    title: "The marketplace refused this server",
    advice:
      "It rejected the key this tLib sent. Update tLib to the latest release, and remove tlib_api_base_url if you set it.",
  },
  rate_limited: {
    title: "The marketplace is rate limiting this server",
    advice: "Too many requests came from this server's address. Wait a minute and try again.",
  },
  unavailable: {
    title: "The marketplace is having trouble",
    advice: `The website answered with a server error. That is on its side and usually clears within minutes. ${REASSURE}`,
  },
  timeout: {
    title: "The marketplace is not answering",
    advice:
      "No reply arrived in time. The server may have a slow connection to the internet, or the website is busy. Try again.",
  },
  unreachable: {
    title: "This server cannot reach the marketplace",
    advice: `The connection failed before the website answered. Check the server's internet access and DNS, and that outgoing HTTPS is allowed. ${REASSURE}`,
  },
  bad_response: {
    title: "The marketplace sent something unexpected",
    advice:
      "The reply was not in the format this tLib expects. Update tLib; if it persists, report the line below.",
  },
  bridge: {
    title: "tLib's marketplace service is not running",
    advice:
      "The part of tLib that talks to the marketplace did not start on this server. Check the boot log for a Node or bundle error, then restart tLib.",
  },
  denied: {
    title: "Not allowed",
    advice: "Browsing the marketplace needs the tlib.admin permission.",
  },
  busy: {
    title: "Still working on earlier requests",
    advice: "Wait a moment and press Retry.",
  },
  cancelled: {
    title: "Request cancelled",
    advice: "Press Retry to load it again.",
  },
  error: {
    title: "Failed to load marketplace",
    advice: "Try again. If it keeps failing, report the line below.",
  },
};
