// A parsed RAGE `Drawable` -> three.js meshes, skinned or static.
//
// Everything stays in GTA axes. The single Z-up -> Y-up frame change lives in one
// wrapper group above the whole rig; applying it here as well is the one mistake
// that produces a character lying on its face with no error.
//
// `DrawableGeometry.boneIds` IS A PER-GEOMETRY REMAP TABLE. A skinned vertex's
// `BlendIndices` index THAT table, not the skeleton, so the skeleton bone is
// `geometry.boneIds[blendIndex]`. Skipping the indirection gives a character that
// looks almost right and deforms horribly, with no error anywhere -- the indices
// are in range either way. On the freemode male components this was written for
// the palette happens to be the identity, which is a property of those files and
// not of the format, so the remap is done unconditionally.
//
// Bone identity is by TAG, never by index: a `.ydd` may embed its own copy of the
// ped skeleton, and `boneIds` then addresses THAT bone order. An embedded
// skeleton is translated tag-wise onto the viewer rig and a disagreement is
// reported rather than silently absorbed.
//

import * as THREE from "three";

import {
  type Drawable,
  type DrawableGeometry,
  decodeVertices,
  type Shader,
  VertexSemantics,
} from "../rage/drawable";
import { decodeToRgba, mipBytes, type Texture, type TextureDictionary } from "../rage/ytd";
import type { ViewerSkeleton } from "./skeleton";

/**
 * Shader-parameter name hashes that mean "the diffuse map", across both
 * generations. Two of them, because gen9 rehashes parameter names and
 * CodeWalker's conversion table is Rockstar-derived and not shipped, so
 * `joaat("DiffuseSampler")` does not match an Enhanced file. The gen9 hash was
 * read off the files this is used with -- evidence, not a table lookup, which is
 * why {@link resolveDiffuse} falls back to "the first texture parameter a
 * dictionary can actually satisfy".
 */
export const DIFFUSE_PARAM_HASHES: readonly number[] = [0xf1fe2b71, 0xc8e8c282];

/**
 * Shaders whose diffuse alpha is a cutout mask rather than opacity.
 *
 * Hair and eyelashes are the cases that matter; rendered opaque they are a solid
 * card around the strands. `alphaTest` rather than `transparent` on purpose: these
 * are hard-edged masks, and transparency would buy sorting artefacts instead.
 */
const CUTOUT_SHADER_HASHES = new Set<number>([
  0x934fa33f, // ped_hair_cutout_alpha
  0x4221fa89, // ped_hair_spiked
  0x44789aa6, // ped_alpha
  0x4fa432a7, // cutout_fence
]);

export interface DrawableMeshOptions {
  /**
   * Dictionaries searched, in order, for a shader's diffuse map. A drawable names
   * its textures and does not carry them, and searching a list rather than taking
   * one lets a shared dictionary sit behind the per-item one.
   */
  textures?: readonly TextureDictionary[];
  /** Bind skinned geometries to this rig. Omit to build a static drawable. */
  skeleton?: ViewerSkeleton;
  /** Which LOD to build, as an index into `drawable.lods`. 0 = High. */
  lod?: number;
  /**
   * Reuse `THREE.Texture` objects across drawables, keyed by texture name hash.
   * Several previews on one page share all of them, so this is what stops a grid
   * of cards uploading the same skin texture once per card.
   */
  textureCache?: Map<number, THREE.Texture | null>;
  /**
   * Which layer of a stack of co-located drawables this one is. Higher wins.
   * Clothing is modelled ON the body and touches it, so without a depth bias the
   * two Z-fight and speckle as the camera moves.
   *
   * It does NOT explain a STATIC grey mark on a component. That is the
   * component's own diffuse map, and it is worth saying because the two were
   * confused here once: the freemode undershirt's texture genuinely carries pale
   * grey rings on the chest, and adding this option did not change them by a pixel.
   * Before reaching for a depth fix, decode the `.ytd` and look at it.
   *
   * 0 is the base body. The caller increments per component in draw order.
   */
  depthLayer?: number;
}

export interface DrawableMeshResult {
  /** Parent this. Its local transform is identity; the meshes are its children. */
  object: THREE.Group;
  meshes: THREE.Mesh[];
  /** True when at least one mesh is a `THREE.SkinnedMesh` awaiting `bind`. */
  skinned: boolean;
  vertices: number;
  triangles: number;
  /**
   * Diffuse maps a shader asked for that no supplied dictionary had.
   *
   * Surfaced rather than swallowed: an untextured ped renders flat grey, which is
   * indistinguishable from a lighting bug and from a deliberate stand-in.
   */
  missingTextures: string[];
  warnings: string[];
  /** Dispose every geometry, material and texture this call created. */
  dispose(): void;
}

/** Bone tag -> index within `skeleton.bones`. */
function tagIndexMap(skeleton: ViewerSkeleton): Map<number, number> {
  const map = new Map<number, number>();
  skeleton.tags.forEach((tag, index) => {
    if (!map.has(tag)) map.set(tag, index);
  });
  return map;
}

/**
 * Skeleton-bone index (as the drawable numbers them) -> viewer bone index.
 *
 * When the drawable embeds a skeleton the translation goes through the bone TAG, so
 * a component authored against a differently-ordered skeleton still binds correctly.
 * With no embedded skeleton the drawable is addressing the ped's own skeleton — the
 * one the caller supplied — and the index passes through.
 */
function boneIndexResolver(
  drawable: Drawable,
  skeleton: ViewerSkeleton,
  warnings: string[]
): (index: number) => number {
  const bones = drawable.skeleton?.bones;
  if (!bones || bones.length === 0) {
    const limit = skeleton.bones.length;
    return (index) => (index >= 0 && index < limit ? index : 0);
  }

  const byTag = tagIndexMap(skeleton);
  const table = new Int32Array(bones.length);
  let unresolved = 0;
  let reordered = 0;
  for (let i = 0; i < bones.length; i++) {
    const viewerIndex = byTag.get(bones[i].tag);
    if (viewerIndex === undefined) {
      table[i] = 0;
      unresolved++;
    } else {
      table[i] = viewerIndex;
      if (viewerIndex !== i) reordered++;
    }
  }
  if (unresolved > 0) {
    warnings.push(
      `${unresolved} of the drawable's ${bones.length} embedded bones carry a tag this ` +
        "skeleton does not have; their vertices are bound to the root bone"
    );
  }
  if (reordered > 0) {
    warnings.push(
      `the drawable's embedded skeleton lists ${reordered} bones in a different order ` +
        "from the rig's; they were matched by tag"
    );
  }
  return (index) => (index >= 0 && index < table.length ? table[index] : 0);
}

/** A `THREE.DataTexture` for one RAGE texture's base mip, or `null` if undecodable. */
export function createRageTexture(texture: Texture): THREE.DataTexture | null {
  let rgba: Uint8Array;
  try {
    rgba = decodeToRgba(texture.dxgi, mipBytes(texture, 0), texture.width, texture.height);
  } catch {
    return null;
  }
  if (rgba.length < texture.width * texture.height * 4) return null;

  const map = new THREE.DataTexture(rgba, texture.width, texture.height, THREE.RGBAFormat);
  map.name = texture.name ?? "";
  // Diffuse maps are authored in sRGB. Without this every skin tone renders washed
  // out, which reads as a lighting problem and is not one.
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  // MIPMAPPED, and it is the hair that makes it non-negotiable.
  //
  // A ped head is ~200 px tall on a browse card while `head_diff`/`hair_diff` are
  // 512x512, so every diffuse map here is MINIFIED 2-3x. Sampling a single level
  // under minification aliases, and on an alpha CUTOUT mask that aliasing is not a
  // shimmer — it is the difference between a haircut and a scatter of dots.
  //
  // The chain is GENERATED rather than taken from the file, even though the `.ytd`
  // carries one: RAGE mip chains stop at the 4x4 block (8 levels for 512x512, not
  // 10), and a `mipmaps` array that does not reach 1x1 leaves the texture
  // MIPMAP-INCOMPLETE in WebGL — which samples black, with no error anywhere.
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  // NO vertical flip. This used to be `true`, and that was the bug.
  //
  // The old comment said "GTA texture space has V running the other way". It does
  // not, for these files: the drawables' UVs already address the atlas in GL's
  // convention, so flipping is what broke them.
  //
  // Measured three ways on the shipped ped head, because the two candidate
  // explanations (flipY ignored for DataTexture vs. flipY honoured) predict
  // different fixes:
  //
  //   pixels unflipped + flipY true   -> wrong   (what shipped)
  //   pixels flipped   + flipY true   -> correct (one flip cancelling the other)
  //   pixels flipped   + flipY false  -> wrong
  //
  // Only "zero net flips" fits all three, so flipY is honoured here and the right
  // answer is simply not to flip.
  //
  // What it ruined looked subtle, because it spoils small features and leaves big
  // ones intact. A face is near-symmetric top to bottom in silhouette, so it still
  // read as a face — with the eyes sampling cheek skin, no irises and no eyebrows.
  // The t-shirt picked up a dark ring and a grey band from the wrong half of its
  // atlas, which reads as "an undershirt clipping through". The radio sampled its
  // own blank back face instead of its keypad.
  //
  // Eye-island UVs sample rgb(92,70,62) (iris) upright and rgb(168,128,113) (cheek)
  // mirrored; mirrored is what was on screen.
  map.flipY = false;
  map.needsUpdate = true;
  return map;
}

/** The texture a shader's diffuse sampler names, looked up across the dictionaries. */
export function resolveDiffuse(
  shader: Shader,
  dictionaries: readonly TextureDictionary[]
): { name: string | null; texture: Texture | null } {
  const textureParams = shader.parameters.filter((p) => p.texture !== null);
  if (textureParams.length === 0) return { name: null, texture: null };

  const byHash = textureParams.filter((p) => DIFFUSE_PARAM_HASHES.includes(p.nameHash >>> 0));
  // The by-hash hit first, then every texture parameter in declaration order. The
  // fallback matters on a shader whose diffuse parameter hash is not in the table:
  // a first-parameter guess that finds a real texture beats a confident nothing.
  const ordered = [...byHash, ...textureParams];

  for (const param of ordered) {
    const ref = param.texture;
    if (!ref?.name) continue;
    for (const dict of dictionaries) {
      const hit = dict.textures.find((t) => t.nameHash === ref.nameHash);
      if (hit) return { name: ref.name, texture: hit };
    }
  }
  // Nothing resolved: report the name the diffuse sampler actually asked for.
  const wanted = (byHash[0] ?? textureParams[0])?.texture?.name ?? null;
  return { name: wanted, texture: null };
}

interface BuiltGeometry {
  geometry: THREE.BufferGeometry;
  skinned: boolean;
}

/** Interleaved RAGE vertex bytes -> a `THREE.BufferGeometry`. */
function buildGeometry(
  geom: DrawableGeometry,
  resolveBone: ((index: number) => number) | null,
  warnings: string[]
): BuiltGeometry | null {
  if (!geom.declaration || geom.verticesCount === 0 || geom.indices.length === 0) return null;

  const decoded = decodeVertices(
    geom.declaration,
    geom.vertexBytes,
    geom.verticesCount,
    geom.vertexStride
  );
  for (const warning of decoded.warnings) warnings.push(warning);

  const position = decoded.bySemantic[VertexSemantics.Position]?.data;
  if (!position || position.length < geom.verticesCount * 3) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));

  const normal = decoded.bySemantic[VertexSemantics.Normal]?.data;
  if (normal && normal.length >= geom.verticesCount * 3) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  }

  const uvAttr = decoded.bySemantic[VertexSemantics.TexCoord0];
  if (uvAttr && uvAttr.componentCount >= 2) {
    const uv = new Float32Array(geom.verticesCount * 2);
    for (let i = 0; i < geom.verticesCount; i++) {
      uv[i * 2] = uvAttr.data[i * uvAttr.componentCount];
      uv[i * 2 + 1] = uvAttr.data[i * uvAttr.componentCount + 1];
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }

  geometry.setIndex(new THREE.BufferAttribute(geom.indices, 1));
  if (!normal) geometry.computeVertexNormals();

  const indices = decoded.bySemantic[VertexSemantics.BlendIndices];
  const weights = decoded.bySemantic[VertexSemantics.BlendWeights];
  let skinned = false;

  if (resolveBone && indices?.raw && weights) {
    const palette = geom.boneIds;
    const skinIndex = new Uint16Array(geom.verticesCount * 4);
    const skinWeight = new Float32Array(geom.verticesCount * 4);
    const weightStride = weights.componentCount;

    for (let v = 0; v < geom.verticesCount; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        // THE REMAP. `raw`, not `data`: GTAV1 declares BlendIndices as a
        // `Colour` component, so the scaled `data` for this slot is
        // index / 255 and is useless as an index.
        const blendIndex = indices.raw[v * 4 + k] ?? 0;
        const bone = palette.length > 0 ? (palette[blendIndex] ?? 0) : blendIndex;
        skinIndex[v * 4 + k] = resolveBone(bone);
        const w = k < weightStride ? (weights.data[v * weightStride + k] ?? 0) : 0;
        skinWeight[v * 4 + k] = w;
        sum += w;
      }
      // A zero-weight vertex would collapse onto the origin. Pin it to its first
      // influence instead, which is what the game's own rig does for rigid parts.
      if (sum <= 1e-6) {
        skinWeight[v * 4] = 1;
      } else if (Math.abs(sum - 1) > 1e-4) {
        for (let k = 0; k < 4; k++) skinWeight[v * 4 + k] /= sum;
      }
    }

    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
    skinned = true;
  }

  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return { geometry, skinned };
}

/**
 * Build the meshes for one drawable.
 *
 * With a `skeleton` the skinned geometries come back as `THREE.SkinnedMesh` that are
 * NOT yet bound — binding needs a bind matrix that only the rig knows, so the caller
 * does it (see `PedPreviewRig.addDrawable`).
 */
export function buildDrawableMeshes(
  drawable: Drawable,
  options: DrawableMeshOptions = {}
): DrawableMeshResult {
  const warnings: string[] = [];
  const missingTextures: string[] = [];
  const object = new THREE.Group();
  object.name = drawable.name ?? "Drawable";
  const meshes: THREE.Mesh[] = [];
  const ownedTextures: THREE.Texture[] = [];
  const dictionaries = options.textures ?? [];
  const cache = options.textureCache;

  // Declared before the early return below: `finish()` closes over all three, and a
  // `let` read before its declaration is a ReferenceError, not a zero.
  let vertices = 0;
  let triangles = 0;
  let anySkinned = false;

  const lod = drawable.lods[options.lod ?? 0];
  if (!lod) {
    warnings.push("the drawable has no LOD to render");
    return finish();
  }

  const resolveBone = options.skeleton
    ? boneIndexResolver(drawable, options.skeleton, warnings)
    : null;

  for (const model of lod.models) {
    for (const geom of model.geometries) {
      const built = buildGeometry(geom, model.hasSkin ? resolveBone : null, warnings);
      if (!built) continue;

      const shader = drawable.shaderGroup?.shaders[geom.shaderIndex] ?? null;
      const material = buildMaterial(shader);

      const mesh = built.skinned
        ? new THREE.SkinnedMesh(built.geometry, material)
        : new THREE.Mesh(built.geometry, material);
      mesh.name = `${object.name}:${geom.shaderIndex}`;
      // Bone-driven bounds are not what `computeBoundingSphere` measured, and a
      // preview that culls its own character because an arm left the rest-pose
      // sphere is a black canvas with no error.
      mesh.frustumCulled = false;
      object.add(mesh);
      meshes.push(mesh);
      anySkinned ||= built.skinned;
      vertices += geom.verticesCount;
      triangles += geom.trianglesCount;
    }
  }

  return finish();

  function buildMaterial(shader: Shader | null): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      // Skin and cloth: no metal, and rough enough that the key light reads as
      // form rather than as a highlight.
      roughness: 0.82,
      metalness: 0,
    });
    if (!shader) {
      material.color.setHex(0x9aa0a6);
      return material;
    }

    const { name, texture } = resolveDiffuse(shader, dictionaries);
    if (texture) {
      const key = texture.nameHash;
      let map = cache?.get(key) ?? null;
      if (!map) {
        map = createRageTexture(texture);
        if (map) {
          if (cache) cache.set(key, map);
          else ownedTextures.push(map);
        }
      }
      if (map) {
        material.map = map;
      } else {
        missingTextures.push(`${name ?? "?"} (format could not be decoded)`);
        material.color.setHex(0x9aa0a6);
      }
    } else {
      if (name) missingTextures.push(name);
      material.color.setHex(0x9aa0a6);
    }

    const layer = options.depthLayer ?? 0;
    if (layer > 0) {
      // Negative units pull the fragment TOWARDS the camera in depth, which is what
      // makes a later component win against the body underneath it. See `depthLayer`.
      //
      // UNITS ONLY. `polygonOffsetFactor` is multiplied by the triangle's DEPTH
      // SLOPE, so on a near-silhouette triangle it is not a small epsilon — it is
      // unbounded. On the freemode t-shirt (layer 4) that put the steep triangles
      // around the hem tens of times further forward than the flat ones BESIDE THEM,
      // and the two then fought: a hard diagonal line across the waist that reads
      // exactly like a second garment cutting through the shirt, appears only at a
      // distance (the slope, and therefore the offset, changes with the camera) and
      // survives removing every other component. Measured: factor 0 clears it
      // completely and no clothing loses to the body underneath, because a fixed bias
      // is all this ever needed — the surfaces are NEAR-coincident, not coplanar.
      material.polygonOffset = true;
      material.polygonOffsetFactor = 0;
      material.polygonOffsetUnits = -layer;
    }

    if (CUTOUT_SHADER_HASHES.has(shader.nameHash >>> 0)) {
      material.alphaTest = 0.5;
      // Hair and eyelash sheets are single-sided cards; without this the far
      // side of every strand is missing.
      material.side = THREE.DoubleSide;
      // A hairline is DITHERED in the source art, not soft-edged.
      //
      // Measured on `hair_diff_001_a_uni`: the alpha channel is bimodal — 56% of
      // texels below 0.1 and 31% above 0.9, with only ~7% in between. So moving
      // `alphaTest` does almost nothing (0.5 keeps 38.5% of texels, 0.1 keeps
      // 44%); the fade at the hairline is stippled ON/OFF texels rather than a
      // ramp, which a binary alpha test can only reproduce as scattered dots.
      //
      // Alpha-to-coverage resolves that stipple through MSAA instead, which is
      // what turns it back into the soft hairline the art intends. It needs a
      // multisampled target, which this renderer has (`antialias: true`); where
      // it is not available the result is simply the alpha-tested look again,
      // so this is safe rather than conditional.
      material.alphaToCoverage = true;
    }
    return material;
  }

  function finish(): DrawableMeshResult {
    return {
      object,
      meshes,
      skinned: anySkinned,
      vertices,
      triangles,
      missingTextures,
      warnings,
      dispose() {
        for (const mesh of meshes) {
          mesh.geometry.dispose();
          const material = mesh.material;
          if (Array.isArray(material)) for (const m of material) m.dispose();
          else material.dispose();
        }
        // Only textures this call created and did NOT hand to a shared cache;
        // disposing a cached texture would blank every other preview using it.
        for (const texture of ownedTextures) texture.dispose();
        object.removeFromParent();
        object.clear();
      },
    };
  }
}
