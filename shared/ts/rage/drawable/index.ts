// `@tlib/shared/rage/drawable` - readers for GTA V drawables (.ydr / .ydd / .yft).
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium) and verified differentially
// against it: see `shared/ts/rage/scripts/verify-drawable.ts`.
//
// ```ts
// import { parseYdr, decodeVertices, VertexSemantics } from "@tlib/shared/rage/drawable";
//
// const file = await parseYdr(new Uint8Array(await blob.arrayBuffer()));
// const geom = file.drawables[0].drawable.lods[0].models[0].geometries[0];
// const verts = decodeVertices(geom.declaration!, geom.vertexBytes, geom.verticesCount);
// const positions = verts.bySemantic[VertexSemantics.Position]!.data; // Float32Array
// ```
//
// Unlike `.ycd`, drawables are **not** generation-agnostic, and the container version
// that tells the two apart is inverted between file types:
//
//   .yft   gen8 = 162   gen9 = 171     (higher is gen9)
//   .ydr   gen8 = 165   gen9 = 159/154 (higher is gen8)
//   .ydd   gen8 = 165   gen9 = 159
//
// So there is no single threshold. `detectGeneration` needs the file kind, which is why
// every entry point here is per-extension rather than one sniffing parser.

import { ResourceReader } from "../reader";
import { parseRsc7, type Rsc7Resource } from "../rsc7";
import {
  type DrawableFile,
  type DrawableParseContext,
  type Generation,
  type NamedDrawable,
  parseDrawableDictionary,
  parseFragment,
  parseSingleDrawable,
} from "./drawable";
import type { Gen9ParamNameResolver } from "./shaders";

export * from "./arrays";
export * from "./drawable";
export * from "./shaders";
export * from "./vertex";

export type DrawableFileKind = "ydr" | "ydd" | "yft";

export interface ParseDrawableOptions {
  /**
   * Force a generation instead of deriving it from the container version.
   *
   * Worth reaching for on a modded file whose version does not match its contents;
   * on anything shipped, the version is reliable.
   */
  generation?: Generation;
  /**
   * Map a gen9 shader-parameter name hash back to its legacy name hash.
   *
   * CodeWalker does this from a 522 KB `ShadersGen9Conversion.xml` that is
   * Rockstar-derived and deliberately not shipped here. Without it, gen9 parameters
   * keep their gen9 name hashes - still stable, still comparable, just not equal to
   * the gen8 hash for the same parameter.
   */
  gen9ParamNames?: Gen9ParamNameResolver;
  /**
   * Resolve a joaat hash back to its name, for `.ydd` entries whose embedded name
   * disagrees with the dictionary key.
   *
   * CodeWalker uses its generated `MetaNames` table plus a JenkIndex built from a
   * whole game scan. Neither is shipped here, so without this hook such an entry is
   * keyed `hash_XXXXXXXX` - which is also what CodeWalker prints when its tables miss.
   */
  resolveHash?: (hash: number) => string | null;
}

/**
 * Which generation a container version means, for a given file kind.
 *
 * Returns `null` for a version this reader does not recognise, so the caller can say
 * so rather than guess and mis-parse every vertex buffer.
 */
export function detectGeneration(kind: DrawableFileKind, version: number): Generation | null {
  if (kind === "yft") {
    if (version === 171) return "gen9";
    if (version === 162) return "gen8";
    return null;
  }
  // .ydr and .ydd: 159 (and 154, seen on some .ydr) are gen9; 165 is gen8.
  if (version === 159 || version === 154) return "gen9";
  if (version === 165) return "gen8";
  return null;
}

function makeContext(generation: Generation, options: ParseDrawableOptions): DrawableParseContext {
  const warnings: string[] = [];
  return {
    generation,
    warnings,
    resolveHash: options.resolveHash,
    shaderOptions: {
      gen9: generation === "gen9",
      gen9ParamNames: options.gen9ParamNames,
      warnings,
    },
  };
}

function parseResource(
  kind: DrawableFileKind,
  resource: Rsc7Resource,
  options: ParseDrawableOptions
): DrawableFile {
  const version = resource.header.version;
  const detected = detectGeneration(kind, version);
  const generation = options.generation ?? detected ?? "gen8";
  const ctx = makeContext(generation, options);
  if (!options.generation && detected === null) {
    ctx.warnings.push(
      `unrecognised .${kind} container version ${version}; assuming gen8. ` +
        "Pass `generation` explicitly if this file is Enhanced."
    );
  }

  const reader = new ResourceReader(resource);
  let drawables: NamedDrawable[];
  if (kind === "ydr") drawables = parseSingleDrawable(reader, ctx);
  else if (kind === "ydd") drawables = parseDrawableDictionary(reader, ctx);
  else drawables = parseFragment(reader, ctx);

  return { kind, version, generation, drawables, warnings: ctx.warnings };
}

/** Parse a `.ydr` from its raw file bytes. */
export async function parseYdr(
  bytes: Uint8Array,
  options: ParseDrawableOptions = {}
): Promise<DrawableFile> {
  return parseResource("ydr", await parseRsc7(bytes), options);
}

/** Parse a `.ydd` drawable dictionary from its raw file bytes. */
export async function parseYdd(
  bytes: Uint8Array,
  options: ParseDrawableOptions = {}
): Promise<DrawableFile> {
  return parseResource("ydd", await parseRsc7(bytes), options);
}

/**
 * Parse a `.yft` and return its fragment's **main** drawable.
 *
 * Damaged drawables, cloth, glass and physics are not decoded in v1; their presence is
 * recorded in `warnings` rather than dropped silently.
 */
export async function parseYft(
  bytes: Uint8Array,
  options: ParseDrawableOptions = {}
): Promise<DrawableFile> {
  return parseResource("yft", await parseRsc7(bytes), options);
}

/** Parse by file kind, for callers that already know the extension. */
export async function parseDrawableFile(
  kind: DrawableFileKind,
  bytes: Uint8Array,
  options: ParseDrawableOptions = {}
): Promise<DrawableFile> {
  return parseResource(kind, await parseRsc7(bytes), options);
}

/** Parse an already-decompressed resource, for callers that hold one. */
export function parseDrawableResource(
  kind: DrawableFileKind,
  resource: Rsc7Resource,
  options: ParseDrawableOptions = {}
): DrawableFile {
  return parseResource(kind, resource, options);
}
