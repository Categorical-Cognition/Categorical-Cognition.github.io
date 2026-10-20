import { inferThetaVolumeBoundary } from "./theta-boundary-inference.js";

// Earlier inspection may precede a creation gesture. Prefer the largest exact
// boundary ending at the latest click, without borrowing Shift intent from a
// discarded selection or resolving an ambiguous boundary by shortening it.
export function inferSurfaceBoundarySelection(presheaf, entries) {
  if (!Array.isArray(entries)) {
    return { ...inferThetaVolumeBoundary(presheaf, null), selectedIds: [] };
  }
  const selectedIds = entries.map((entry) => entry?.id);
  if (!entries.some((entry) => entry?.shiftKey)) {
    return { status: "incomplete", reason: "creation-not-requested",
      candidates: [], selectedIds };
  }
  const full = inferThetaVolumeBoundary(presheaf, selectedIds);
  for (let start = 0; start <= entries.length - 2; start += 1) {
    const suffix = entries.slice(start);
    if (!suffix.some((entry) => entry?.shiftKey)) break;
    const ids = selectedIds.slice(start);
    const inference = start === 0 ? full : inferThetaVolumeBoundary(presheaf, ids);
    if (inference.status === "matched" || inference.status === "ambiguous") {
      return { ...inference, selectedIds: ids };
    }
  }
  return { ...full, selectedIds };
}
