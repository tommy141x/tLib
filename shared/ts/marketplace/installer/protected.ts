// The built-in boundary: which files a consumer shipped in its own release, and
// therefore which destinations the marketplace must refuse to touch.
import AdmZip from "adm-zip";
import { zipEntryCount } from "./bundle";
import {
  type Context,
  DESTINATIONS,
  hash,
  type InstallTarget,
  MAX_ENTRIES,
  type ProtectedBuiltinInventory,
  safeName,
} from "./core";

/** Validate and detach consumer configuration so later caller mutations cannot relax protection. */
export function snapshotProtectedInventory(
  value: ProtectedBuiltinInventory,
  resourceName: string
): ProtectedBuiltinInventory {
  if (
    typeof resourceName !== "string" ||
    !resourceName ||
    !value ||
    value.schema !== 1 ||
    value.resourceName !== resourceName ||
    typeof value.releaseHash !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.releaseHash) ||
    (value.source !== undefined &&
      value.source !== "release-zip" &&
      value.source !== "release-staging") ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > MAX_ENTRIES
  ) {
    throw new Error("invalid protected built-in inventory");
  }
  const files: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const name of value.files) {
    length += name.length;
    if (!safeName(name) || length > 1024 * 1024 || seen.has(name.toLowerCase())) {
      throw new Error("unsafe or aliased protected inventory path");
    }
    seen.add(name.toLowerCase());
    files.push(name);
  }
  return Object.freeze({
    schema: 1 as const,
    resourceName,
    releaseHash: value.releaseHash.toLowerCase(),
    ...(value.source ? { source: value.source } : {}),
    files: Object.freeze(files.sort()),
  });
}

/**
 * Build-time only. Takes the complete official release ZIP and an independently
 * trusted digest; the returned inventory is meant to be embedded in the
 * consumer. Accepts the resource-root wrapper from ProductionStager/createZip.
 * ZIP64, oversized (>512 MiB) and >1024-entry releases fail closed.
 */
export function protectedInventoryFromRelease(
  resourceName: string,
  releaseBytes: Buffer,
  expectedHash: string
): ProtectedBuiltinInventory {
  if (!safeName(resourceName) || resourceName.includes("/"))
    throw new Error("invalid release resource name");
  if (
    !Buffer.isBuffer(releaseBytes) ||
    !releaseBytes.length ||
    releaseBytes.length > 512 * 1024 * 1024
  ) {
    throw new Error("release inventory input exceeds limit or is empty");
  }
  if (
    typeof expectedHash !== "string" ||
    !/^(?:sha256:)?[a-f0-9]{64}$/i.test(expectedHash) ||
    hash(releaseBytes) !== expectedHash.toLowerCase().replace(/^sha256:/, "")
  )
    throw new Error("release hash mismatch");
  const count = zipEntryCount(releaseBytes);
  const entries = new AdmZip(releaseBytes).getEntries();
  if (entries.length !== count) throw new Error("invalid release zip entry count");
  const files: string[] = [];
  const spellings = new Map<string, string>();
  const kinds = new Map<string, boolean>();
  for (const entry of entries) {
    const name = entry.isDirectory ? entry.entryName.replace(/\/$/, "") : entry.entryName;
    if (
      !safeName(name) ||
      (!(name === resourceName && entry.isDirectory) && !name.startsWith(`${resourceName}/`))
    ) {
      throw new Error("release entry outside resource wrapper or unsafe path");
    }
    const mode = (entry.attr >>> 16) & 0xf000;
    if (entry.header.flags & 1 || (mode && mode !== (entry.isDirectory ? 0x4000 : 0x8000))) {
      throw new Error("unsupported release entry type");
    }
    const key = name.toLowerCase();
    if (kinds.has(key)) throw new Error("duplicate release entry");
    kinds.set(key, entry.isDirectory);
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const old = spellings.get(prefix.toLowerCase());
      if (old && old !== prefix) throw new Error("case-aliased release path");
      spellings.set(prefix.toLowerCase(), prefix);
    }
    if (!entry.isDirectory) files.push(name.slice(resourceName.length + 1));
  }
  for (const name of kinds.keys()) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (kinds.get(parts.join("/")) === false) throw new Error("release file/directory conflict");
    }
  }
  return snapshotProtectedInventory(
    { schema: 1, resourceName, releaseHash: hash(releaseBytes), files },
    resourceName
  );
}

export function protectedLegacyDestination(target: InstallTarget, c: Context): boolean {
  if (!target.protectedInventory) return false;
  const policy = snapshotProtectedInventory(target.protectedInventory, c.resourceName);
  // Protect the whole destination subtree and every flat audio variant,
  // including shipped paths that an operator has since removed from the mutable
  // disk. The same list the installer and the inspector use.
  const candidates = DESTINATIONS(c).map((name) => `${target.installPath}/${name}`.toLowerCase());
  return policy.files.some((file) => {
    const lower = file.toLowerCase();
    return candidates.some(
      (candidate) =>
        lower === candidate ||
        lower.startsWith(`${candidate}/`) ||
        candidate.startsWith(`${lower}/`)
    );
  });
}
