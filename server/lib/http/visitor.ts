// Is a request evidence that the printed address works for somebody else?
//
// Only a request from ANOTHER machine is. Loopback is this one, and so is the host's own
// detected public address, which is what a probe through the router arrives as. tLib's own
// health check says who it is in its User-Agent and is skipped on that alone: with a hostname
// as the public address it comes back from this host's public address, and a router that
// hairpins would otherwise count the server visiting itself as the outside world.

/** The User-Agent shared/imports/healthcheck/server.lua sends. */
const HEALTH_CHECK_AGENT = "tLib-HealthCheck";

export function isVisitor(
  address: unknown,
  userAgent: unknown,
  ownPublicIp: string | null
): boolean {
  if (typeof userAgent === "string" && userAgent.startsWith(HEALTH_CHECK_AGENT)) return false;
  if (typeof address !== "string") return false;
  const ip = address.trim().toLowerCase().replace(/^::ffff:/, "");
  if (ip === "" || ip === "localhost" || ip === "::" || ip === "0.0.0.0") return false;
  if (ip === "::1" || ip.startsWith("127.")) return false;
  return ip !== ownPublicIp?.toLowerCase();
}
