import { describe, expect, test } from "bun:test";
import {
  type InspectionRequest,
  inspectableIdentity,
  matchesInspectionReply,
  summarizeInspection,
} from "../../client/web/src/components/marketplace/inspection";

const request: InspectionRequest = {
  resource: "tRadio",
  type: "ui",
  slug: "custom-layout",
  requestId: "session-1-1",
};

describe("marketplace inspection UI identity", () => {
  const wire = {
    resourceName: request.resource,
    type: request.type,
    slug: request.slug,
    status: "managed",
    lock: "absent",
    policyAvailable: true,
  };
  test("only managed unchanged unlocked content has normal existing management controls", () => {
    expect(summarizeInspection(wire, request)?.managementBlocked).toBe(false);
    for (const status of [
      "modified",
      "unverified",
      "protected",
      "missing",
      "unsafe",
      "unavailable",
    ]) {
      expect(summarizeInspection({ ...wire, status }, request)?.managementBlocked).toBe(true);
    }
    for (const lock of ["identified", "unidentified", "recovery-pending", "unavailable"]) {
      expect(summarizeInspection({ ...wire, lock }, request)?.managementBlocked).toBe(true);
    }
    expect(
      summarizeInspection({ ...wire, policyAvailable: false }, request)?.policyUnavailable
    ).toBe(true);
  });

  test("invalid nested scope or enum is not a classification; arbitrary server text is not rendered", () => {
    for (const patch of [
      { resourceName: "other" },
      { type: "sound" },
      { slug: "other" },
      { status: "owned" },
      { status: "toString" },
      { lock: "constructor" },
      { policyAvailable: "yes" },
    ]) {
      expect(summarizeInspection({ ...wire, ...patch }, request)).toBeNull();
    }
    expect(summarizeInspection(null, request)).toBeNull();
    expect(
      summarizeInspection(
        { ...wire, error: "C:/private/server/layouts", description: "untrusted" },
        request
      )?.description
    ).not.toContain("private");
    expect(
      summarizeInspection({ ...wire, description: "untrusted" }, request)?.description
    ).not.toContain("untrusted");
  });
  test("only canonical identities can be requested; local names are not rewritten", () => {
    expect(inspectableIdentity("tRadio", "custom-layout")).toBe(true);
    for (const resource of [null, "", "../radio", "radio/name", "a".repeat(129)])
      expect(inspectableIdentity(resource, "custom")).toBe(false);
    for (const slug of [null, "", "../custom", "Custom Layout", "beep.ogg", "a".repeat(129)])
      expect(inspectableIdentity("tRadio", slug)).toBe(false);
  });

  test("a result is bound to the exact UI request and scope", () => {
    expect(matchesInspectionReply(request, { ...request, ok: true })).toBe(true);
    expect(matchesInspectionReply(request, { ...request, ok: false })).toBe(true);
    for (const field of ["resource", "type", "slug", "requestId"]) {
      expect(matchesInspectionReply(request, { ...request, ok: true, [field]: "other" })).toBe(
        false
      );
      const missing: Record<string, unknown> = { ...request, ok: true };
      delete missing[field];
      expect(matchesInspectionReply(request, missing)).toBe(false);
    }
    expect(matchesInspectionReply(request, { ...request, ok: "true" })).toBe(false);
    expect(matchesInspectionReply(request, null)).toBe(false);
    expect(
      matchesInspectionReply({ ...request, requestId: "session-2-1" }, { ...request, ok: true })
    ).toBe(false);
  });
});
