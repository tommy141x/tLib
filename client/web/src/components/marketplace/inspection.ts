export interface InspectionSummary {
  label: string;
  description: string;
  managementBlocked: boolean;
  policyUnavailable: boolean;
}

const statuses = {
  managed: {
    label: "Managed · unchanged",
    description: "The local files match their marketplace ownership receipt.",
  },
  modified: {
    label: "Managed · modified",
    description:
      "The local files no longer match their receipt. Keep your edits; automatic replacement and deletion are blocked.",
  },
  unverified: {
    label: "Unverified / custom",
    description:
      "No verified ownership receipt covers these files. This may be a legacy installation or custom content; inspection does not claim ownership.",
  },
  protected: {
    label: "Protected built-in",
    description:
      "The trusted built-in inventory protects this destination. Marketplace replacement and deletion are blocked.",
  },
  missing: {
    label: "Files not found",
    description:
      "No installation was found at this identity. The supplied installed list may be out of date; inspection does not change that list.",
  },
  unsafe: {
    label: "Unsafe or ambiguous state",
    description:
      "Ownership cannot be established safely. Leave these files unchanged and review the installation before managing it.",
  },
  unavailable: {
    label: "Inspection incomplete",
    description:
      "The local state could not be safely verified within inspection limits. No ownership conclusion was made.",
  },
} as const;
const locks = {
  absent: "",
  identified: " An operation lock is present; management remains blocked.",
  unidentified:
    " An unidentified operation lock requires review; it cannot be removed based on age.",
  "recovery-pending":
    " Lock recovery is pending. Management remains blocked until recovery is verified.",
  unavailable: " Lock state could not be verified. Management remains blocked.",
} as const;

/** Ignore unrecognized or mismatched wire data rather than claiming a management state. */
export function summarizeInspection(
  value: unknown,
  request: InspectionRequest
): InspectionSummary | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    data.resourceName !== request.resource ||
    data.type !== request.type ||
    data.slug !== request.slug ||
    typeof data.policyAvailable !== "boolean" ||
    typeof data.status !== "string" ||
    typeof data.lock !== "string" ||
    !Object.hasOwn(statuses, data.status) ||
    !Object.hasOwn(locks, data.lock)
  )
    return null;
  const status = data.status as keyof typeof statuses;
  const lock = data.lock as keyof typeof locks;
  return {
    label: statuses[status].label,
    description: statuses[status].description + locks[lock],
    managementBlocked: status !== "managed" || lock !== "absent",
    policyUnavailable: !data.policyAvailable,
  };
}

export interface InspectionRequest {
  resource: string;
  type: "ui" | "sound";
  slug: string;
  requestId: string;
}

export function inspectableIdentity(resource: string | null, slug: string | null): boolean {
  return (
    typeof resource === "string" &&
    /^[\w][\w.-]{0,127}$/.test(resource) &&
    !resource.includes("..") &&
    typeof slug === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug)
  );
}

/** All scope fields must match; neither a slug nor an agent token identifies a UI session. */
export function matchesInspectionReply(
  request: InspectionRequest,
  reply: unknown
): reply is InspectionRequest & { ok: boolean; inspection?: unknown; error?: unknown } {
  if (!reply || typeof reply !== "object") return false;
  const value = reply as Record<string, unknown>;
  return (
    typeof value.ok === "boolean" &&
    value.requestId === request.requestId &&
    value.resource === request.resource &&
    value.type === request.type &&
    value.slug === request.slug
  );
}
