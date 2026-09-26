/**
 * Whom a drawn pixel belongs to, in the world's owner channel: nothing, a
 * building (by id), a field or a pasture. Their state (a fire's char, lit
 * windows, a crop's ripeness) is looked up when the pixel is shaded, so it
 * can change without drawing the pixel again.
 */
export const BUILDING_OWNER = 1;
export const FIELD_OWNER = 40000;
export const PASTURE_OWNER = 45000;
export const OWNERS = 46000;
