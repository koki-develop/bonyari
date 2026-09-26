import { decodeRecord, encodeRecord, type SettlementRecord } from "../sim/record.ts";

const KEY = "bonyari:settlement:town";

/**
 * The settlement as left on this device, or null. Storage may be unavailable
 * (blocked site data, some private modes), in which case every visit starts anew.
 */
export function loadTown(): SettlementRecord | null {
  try {
    const text = localStorage.getItem(KEY);
    return text === null ? null : decodeRecord(text);
  } catch {
    return null;
  }
}

/** Forgets the settlement kept on this device, so the next visit starts anew. */
export function forgetTown(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage that can't be reached holds nothing to forget.
  }
}

/** Keeps the settlement; without storage (blocked, full) the next visit starts anew. */
export function saveTown(record: SettlementRecord): void {
  try {
    localStorage.setItem(KEY, encodeRecord(record));
  } catch {
    // Nothing else to fall back on: the visit goes on, it just can't be returned to.
  }
}
