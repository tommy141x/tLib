// `.ytd` texture dictionaries: parsing, CPU decoding and WebGL upload.
//
//   import { parseYtd, decodeToRgba, mipBytes } from "@tlib/shared/rage/ytd";
//
//   const dict = await parseYtd(new Uint8Array(await file.arrayBuffer()));
//   const tex = dict.textures[0];
//   const rgba = decodeToRgba(tex.dxgi, mipBytes(tex, 0), tex.width, tex.height);
//
// `upload.ts` is re-exported here too, but it is the only part that touches WebGL; a
// worker that only decodes should import `./decode` directly so nothing DOM-shaped ends
// up in its bundle.

import { ResourceReader } from "../reader";
import { parseRsc7 } from "../rsc7";
import type { TextureDictionary } from "./ytd";
import { parseTextureDictionary } from "./ytd";

export * from "./bc7-tables";
export * from "./decode";
export * from "./formats";
export * from "./upload";
export * from "./ytd";

/** Parse a `.ytd` texture dictionary from its raw file bytes. */
export async function parseYtd(bytes: Uint8Array): Promise<TextureDictionary> {
	const resource = await parseRsc7(bytes);
	return parseTextureDictionary(resource, new ResourceReader(resource));
}
