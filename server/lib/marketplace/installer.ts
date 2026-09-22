// Registry adapter; disk transactions are shared with the consumer-bundled agent.

import {
  type InstallOutcome,
  type InstallTarget,
  installFromData as install,
  type UninstallOutcome,
  uninstallItem as uninstall,
} from "../../../shared/ts/marketplace/installer";
import { resolveConfig } from "./config";
import { fGetResourcePath } from "./fivem";
import { get as getTarget } from "./registry";

export type {
  InstallFailure,
  InstallOutcome,
  InstallResult,
  UninstallOutcome,
  UninstallResult,
} from "../../../shared/ts/marketplace/installer";

function targetFor(resourceName: string, type: string): InstallTarget {
  const target = getTarget(resourceName, type);
  if (!target || target.resourceName !== resourceName || target.type !== type)
    throw new Error("no matching install target registered");
  const resourceRoot = fGetResourcePath(resourceName);
  if (!resourceRoot) throw new Error("resource has no resolvable path");
  return { ...target, resourceRoot, maxBundleBytes: resolveConfig().maxBundleBytes };
}

export function installFromData(
  resourceName: string,
  type: string,
  slug: string,
  bytes: Buffer,
  expectedHash: string,
  expectedSize: number
): InstallOutcome {
  try {
    return install(targetFor(resourceName, type), slug, bytes, expectedHash, expectedSize);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function uninstallItem(resourceName: string, type: string, slug: string): UninstallOutcome {
  try {
    return uninstall(targetFor(resourceName, type), slug);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
