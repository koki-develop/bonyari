import { decodeJourney, encodeJourney, type Journey } from "../sim/journey.ts";

const KEY = "bonyari:train-window:journey";

/**
 * The ride saved on this device, or null. Storage may be unavailable (blocked
 * site data, some private modes), in which case every ride starts anew.
 */
export function loadJourney(): Journey | null {
  try {
    const text = localStorage.getItem(KEY);
    return text === null ? null : decodeJourney(text);
  } catch {
    return null;
  }
}

/** Saves the ride; without storage (blocked, full) the next visit starts anew. */
export function saveJourney(journey: Journey): void {
  try {
    localStorage.setItem(KEY, encodeJourney(journey));
  } catch {
    // Nothing else to fall back on: the ride goes on, it just can't be resumed.
  }
}
