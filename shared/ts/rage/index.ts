// @tlib/shared/rage - readers for RAGE (GTA V) resource files.
//
// Framework-agnostic and dependency-free: runs in the browser, in NUI (CEF 103) and in
// bun/node alike. Rendering lives in a separate module so parsing stays testable
// headlessly and three.js stays out of the import graph for callers that only need data.
//
// Ported from CodeWalker.Core (MIT, dexyfex/Neodymium) and verified differentially
// against it - see shared/ts/rage/scripts/verify-ycd.ts.
//
// Scope: loose, unencrypted resource files, which is what a FiveM resource streams.
// RPF archive entries are NG-encrypted and out of scope.

export * from "./drawable";
export * from "./jenk";
export * from "./reader";
export * from "./rsc7";
export * from "./ycd";
export * from "./ytd";
