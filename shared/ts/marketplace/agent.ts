// Bundled into each consumer: disk writes stay inside the owning resource VM.
import { downloadBundle } from "./download";
import {
  adoptLegacyInstallationFromData,
  type InstallationInspectionOutcome,
  type InstallTarget,
  inspectInstallation,
  installFromData,
  type LegacyAdoptionAuthorization,
  type LegacyAdoptionOutcome,
  type ProtectedBuiltinInventory,
  snapshotProtectedInventory,
  uninstallItem,
} from "./installer";

const g = globalThis as unknown as {
  GetCurrentResourceName: () => string;
  GetResourcePath: (name: string) => string;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
};

export interface AgentConfig {
  /** Resource-relative directories for accepted item types. */
  installTypes: Record<string, string>;
  /** Download and expanded ZIP byte limit. Default 100 MB. */
  maxBundleBytes?: number;
  /** Embedded inventory from the complete trusted release, never current runtime disk. */
  protectedInventory?: ProtectedBuiltinInventory;
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
  const resourceRoot = g.GetResourcePath(resourceName);
  const maxBundleBytes = config.maxBundleBytes ?? 100 * 1024 * 1024;
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
    return inspectInstallation(
      {
        resourceName,
        resourceRoot,
        type,
        installPath: config.installTypes[type],
        maxBundleBytes,
        ...(protectedInventory ? { protectedInventory } : {}),
      },
      slug
    );
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
    const target: InstallTarget = {
      resourceName,
      resourceRoot,
      type: p.type,
      installPath: config.installTypes[p.type],
      maxBundleBytes,
      ...(protectedInventory ? { protectedInventory } : {}),
    };
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
  return {
    inspect,
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
          {
            resourceName,
            resourceRoot,
            type,
            installPath: config.installTypes[type],
            maxBundleBytes,
            protectedInventory,
          },
          slug,
          bytes,
          expectedHash,
          expectedSize,
          authorization
        );
      } finally {
        locks.delete(key);
      }
    },
  };
}
