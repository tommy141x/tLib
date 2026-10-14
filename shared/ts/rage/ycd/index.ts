import { ResourceReader } from "../reader";
import { parseRsc7 } from "../rsc7";
import type { ClipDictionary } from "./clip";
import { parseClipDictionary } from "./clip";

export * from "./channels";
export * from "./clip";

/** Parse a `.ycd` clip dictionary from its raw file bytes. */
export async function parseYcd(bytes: Uint8Array): Promise<ClipDictionary> {
  const resource = await parseRsc7(bytes);
  return parseClipDictionary(resource, new ResourceReader(resource));
}
