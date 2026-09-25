import { type ColonyRecord, decodeRecord, encodeRecord } from "../sim/record.ts";

const KEY = "bonyari:ant-nest:colony";

/**
 * The colony as left on this device, or null. Storage may be unavailable
 * (blocked site data, some private modes), in which case every visit starts anew.
 */
export function loadColony(): ColonyRecord | null {
  try {
    const text = localStorage.getItem(KEY);
    return text === null ? null : decodeRecord(text);
  } catch {
    return null;
  }
}

/** Keeps the colony; without storage (blocked, full) the next visit starts anew. */
export function saveColony(record: ColonyRecord): void {
  try {
    localStorage.setItem(KEY, encodeRecord(record));
  } catch {
    // Nothing else to fall back on: the visit goes on, it just can't be returned to.
  }
}
