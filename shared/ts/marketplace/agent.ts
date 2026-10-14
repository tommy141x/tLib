// Bundled into each consumer: disk writes stay inside the owning resource VM.
import { downloadBundle } from "./download";
import {
  adoptLegacyInstallationFromData,
  type ContentValidator,
  type InstallationInspectionOutcome,
  type InstallTarget,
  inspectInstallation,
  installFromData,
  type LegacyAdoptionAuthorization,
  type LegacyAdoptionOutcome,
  type ProtectedBuiltinInventory,
  resetInstalledToShipped,
  snapshotProtectedInventory,
  uninstallItem,
} from "./installer";

const g = globalThis as unknown as {
  GetCurrentResourceName: () => string;
  GetResourcePath: (name: string) => string;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
};

/**
 * Where one item type's content lands.
 *
 * A bare string is a directory inside the CONSUMER's own resource — the original
 * and still the normal case (`ui: "layouts"`).
 *
 * The object form names a DIFFERENT resource. It exists because some content
 * cannot be installed into the consumer at all: a FiveM resource's `stream/`
 * folder is scanned once, in `ResourceStreamComponent::OnStart`, and `refresh`
 * does not rescan it. So making a newly-downloaded `.ycd`/`.ydr` reachable means
 * restarting the resource that owns the `stream/` folder — and restarting tRadio
 * would drop every player's channel, codeplug and PTT state for a cosmetic pack.
 * Writing into a generated, asset-only COMPANION resource instead means the
 * restart lands on something with no runtime state at all.
 *
 * `resource` must already exist and be known to the server (`GetResourcePath`
 * answers for it); otherwise the install fails closed with "resource has no
 * resolvable path". The consumer is responsible for creating and `refresh`ing
 * the companion before offering the type — see tRadio's `ensureCompanion()`.
 * `path` is still validated by `safeName`, so it can never escape that root.
 */
export type InstallTypeTarget = string | { resource: string; path: string };

export interface AgentConfig {
  /** Accepted item types, and where each one's content is written. */
  installTypes: Record<string, InstallTypeTarget>;
  /** Download and expanded ZIP byte limit. Default 100 MB. */
  maxBundleBytes?: number;
  /** Embedded inventory from the complete trusted release, never current runtime disk. */
  protectedInventory?: ProtectedBuiltinInventory;
  /**
   * Per-type content contracts, keyed exactly like `installTypes`. A type with no entry
   * declares no contract and installs as before.
   *
   * Registered HERE, on the agent, rather than at each call site, so that every route into
   * this resource's install path is gated by the same check: the in-game Lua event handled
   * below, and any HTTP/admin route the consumer builds on `installFromData` directly. A
   * contract enforced on only one of those is a contract an operator can walk around without
   * knowing they did.
   *
   * See {@link ContentValidator} — reject by throwing, and write the message for the server
   * owner who will read it.
   */
  validators?: Record<string, ContentValidator>;
}
interface Payload {
  url?: string;
  slug: string;
  type: string;
  token: string;
}

export interface MarketplaceAgent {
  /** Read-only snapshot; never authorizes adoption or replacement. */
  inspect(type: string, slug: string): InstallationInspectionOutcome;
  /**
   * Uninstall every marketplace item this resource owns, across all types.
   *
   * Demo mode's start-time reset. Only receipt-owned content is removed, so what
   * the resource shipped with — including preinstalled catalogue items — is
   * untouched: it has no receipt, and `owned()` refuses any unreceipted path
   * outright. That, and not the protected inventory, is what keeps it safe.
   */
  resetToShipped(): { removed: string[]; failed: { slug: string; error: string }[] };
  /** Local-only API for a future authorized operator workflow; no adoption event is registered. */
  adoptLegacyFromData(
    type: string,
    slug: string,
    bytes: Buffer,
    expectedHash: string,
    expectedSize: number,
    authorization: LegacyAdoptionAuthorization
  ): LegacyAdoptionOutcome;
}

export function createMarketplaceAgent(config: AgentConfig): MarketplaceAgent {
  const resourceName = g.GetCurrentResourceName();
  const ownRoot = g.GetResourcePath(resourceName);
  const maxBundleBytes = config.maxBundleBytes ?? 100 * 1024 * 1024;
  // Resolved per call, never once at construction: a companion resource may be
  // created and `refresh`ed after this agent is built, and it may be stopped and
  // recreated underneath us. `resourceName` deliberately stays the CONSUMER's —
  // receipts, locks and the registry key all attribute ownership to the resource
  // that registered the type, not to wherever the bytes happen to land.
  function buildTarget(type: string): InstallTarget {
    const spec = config.installTypes[type];
    const [root, installPath] =
      typeof spec === "string" ? [ownRoot, spec] : [g.GetResourcePath(spec.resource), spec.path];
    if (!root)
      throw new Error(
        typeof spec === "string"
          ? "resource has no resolvable path"
          : `install target resource "${spec.resource}" is not started or has no resolvable path`
      );
    const validate = config.validators?.[type];
    return {
      resourceName,
      resourceRoot: root,
      type,
      installPath,
      maxBundleBytes,
      ...(protectedInventory ? { protectedInventory } : {}),
      ...(validate ? { validate } : {}),
    };
  }
  const protectedInventory =
    config.protectedInventory === undefined
      ? undefined
      : snapshotProtectedInventory(config.protectedInventory, resourceName);
  const locks = new Set<string>();
  let stopped = false;
  g.on("onResourceStop", (name) => {
    if (name === resourceName) stopped = true;
  });

  function inspect(type: string, slug: string): InstallationInspectionOutcome {
    if (stopped) return { ok: false, error: "consumer stopped" };
    if (
      typeof type !== "string" ||
      !Object.hasOwn(config.installTypes, type) ||
      typeof slug !== "string" ||
      slug.length > 128 ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(slug)
    ) {
      return { ok: false, error: "invalid marketplace inspection target" };
    }
    if (locks.has(`${type}:${slug}`))
      return {
        ok: true,
        inspection: {
          resourceName,
          type,
          slug,
          status: "unavailable",
          lock: "unavailable",
          policyAvailable: !!protectedInventory,
        },
      };
    try {
      return inspectInstallation(buildTarget(type), slug);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  g.on(`tlib:marketplace:doInspect:${resourceName}`, (raw) => {
    if (stopped || !raw || typeof raw !== "object") return;
    const p = raw as Payload;
    if (typeof p.token !== "string" || !p.token || p.token.length > 128) return;
    const result = inspect(p.type, p.slug);
    if (!stopped)
      g.emit("tlib:marketplace:agentResult", { token: p.token, slug: p.slug, ...result });
  });

  function receive(raw: unknown, action: "install" | "uninstall") {
    if (stopped || !raw || typeof raw !== "object") return;
    const p = raw as Payload;
    if (typeof p.token !== "string" || !p.token || p.token.length > 128) return;
    const reply = (result: { ok: boolean; error?: string }) => {
      if (!stopped)
        g.emit("tlib:marketplace:agentResult", { token: p.token, slug: p.slug, ...result });
    };
    if (
      typeof p.slug !== "string" ||
      p.slug.length > 128 ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(p.slug) ||
      typeof p.type !== "string" ||
      !Object.hasOwn(config.installTypes, p.type) ||
      (action === "install" && typeof p.url !== "string")
    ) {
      reply({ ok: false, error: "invalid marketplace arguments or unknown type" });
      return;
    }
    const key = `${p.type}:${p.slug}`;
    if (locks.has(key)) {
      reply({ ok: false, error: "marketplace operation already in progress" });
      return;
    }
    let target: InstallTarget;
    try {
      target = buildTarget(p.type);
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    locks.add(key);
    if (action === "uninstall") {
      try {
        reply(uninstallItem(target, p.slug));
      } finally {
        locks.delete(key);
      }
      return;
    }
    void downloadBundle(p.url!, maxBundleBytes)
      .then(({ buf, hash, size }) => {
        if (!stopped) reply(installFromData(target, p.slug, buf, hash, size));
      })
      .catch((error: unknown) =>
        reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
      )
      .finally(() => locks.delete(key));
  }
  g.on(`tlib:marketplace:doInstall:${resourceName}`, (raw) => receive(raw, "install"));
  g.on(`tlib:marketplace:doUninstall:${resourceName}`, (raw) => receive(raw, "uninstall"));
  function resetToShipped() {
    const removed: string[] = [];
    const failed: { slug: string; error: string }[] = [];
    if (stopped) return { removed, failed };
    // Every registered type, because demo mode resets the resource, not one
    // corner of it — and two types can land in the same directory, which the
    // per-type receipt check in resetInstalledToShipped sorts out.
    for (const type of Object.keys(config.installTypes)) {
      let outcome: ReturnType<typeof resetInstalledToShipped>;
      try {
        outcome = resetInstalledToShipped(buildTarget(type));
      } catch (error) {
        // A type whose target resource is not started yet has nothing installed
        // that we could reach anyway; record it and carry on to the rest.
        failed.push({
          slug: `${type}:*`,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!outcome.ok) {
        failed.push({ slug: `${type}:*`, error: outcome.error });
        continue;
      }
      for (const slug of outcome.removed) removed.push(`${type}:${slug}`);
      for (const entry of outcome.failed)
        failed.push({ slug: `${type}:${entry.slug}`, error: entry.error });
    }
    return { removed, failed };
  }

  // tLib fires this once per resource at start, and only when tlib_demo is on.
  // It takes no payload it trusts: there is nothing to parameterise, so there is
  // nothing an attacker could steer. The operation is idempotent and, on a
  // server that is not in demo mode, never dispatched at all.
  g.on(`tlib:marketplace:doDemoReset:${resourceName}`, () => {
    if (stopped) return;
    const { removed, failed } = resetToShipped();
    if (removed.length)
      console.log(
        `[${resourceName}] demo mode: removed ${removed.length} marketplace item(s) — ${removed.join(", ")}`
      );
    for (const entry of failed)
      console.warn(`[${resourceName}] demo mode: could not remove ${entry.slug} — ${entry.error}`);
  });

  return {
    inspect,
    resetToShipped,
    adoptLegacyFromData(type, slug, bytes, expectedHash, expectedSize, authorization) {
      if (stopped) return { ok: false, error: "consumer stopped" };
      if (!protectedInventory) return { ok: false, error: "builtin-boundary-unavailable" };
      if (
        typeof type !== "string" ||
        !Object.hasOwn(config.installTypes, type) ||
        typeof slug !== "string" ||
        slug.length > 128 ||
        !/^[a-z0-9][a-z0-9_-]*$/.test(slug)
      )
        return { ok: false, error: "invalid legacy adoption target" };
      const key = `${type}:${slug}`;
      if (locks.has(key)) return { ok: false, error: "marketplace operation already in progress" };
      locks.add(key);
      try {
        return adoptLegacyInstallationFromData(
          { ...buildTarget(type), protectedInventory },
          slug,
          bytes,
          expectedHash,
          expectedSize,
          authorization
        );
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        locks.delete(key);
      }
    },
  };
}
