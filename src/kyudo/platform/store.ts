import { decodeRecord, type DojoRecord, encodeRecord } from "../sim/record.ts";

const KEY = "bonyari:kyudo:dojo";

/**
 * The dojo as left on this device, or null. Storage may be unavailable
 * (blocked site data, some private modes), in which case every visit starts anew.
 */
export function loadDojo(): DojoRecord | null {
  try {
    const text = localStorage.getItem(KEY);
    return text === null ? null : decodeRecord(text);
  } catch {
    return null;
  }
}

/** Keeps the dojo; without storage (blocked, full) the next visit starts anew. */
export function saveDojo(record: DojoRecord): void {
  try {
    localStorage.setItem(KEY, encodeRecord(record));
  } catch {
    // Nothing else to fall back on: the visit goes on, it just can't be returned to.
  }
}
