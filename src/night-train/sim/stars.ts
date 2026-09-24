import type { RGB } from "../core/color.ts";
import { DEG, TAU } from "../core/math.ts";
import { Rng } from "../core/random.ts";
import { galacticToEquatorial } from "./astro.ts";

export interface Star {
  ra: number;
  dec: number;
  mag: number;
  color: RGB;
  /** Diffuse Milky Way glow rather than a point star. */
  haze: boolean;
}

const BLUE: RGB = [196, 214, 255];
const WHITE: RGB = [238, 240, 255];
const YELLOW: RGB = [255, 244, 214];
const ORANGE: RGB = [255, 214, 164];
const RED: RGB = [255, 178, 138];

/** Bright stars: right ascension (hours), declination (degrees), magnitude, color. */
const CATALOG: readonly (readonly [number, number, number, RGB])[] = [
  [6.752, -16.72, -1.46, WHITE], // Sirius
  [14.261, 19.18, -0.05, ORANGE], // Arcturus
  [18.616, 38.78, 0.03, WHITE], // Vega
  [5.278, 46.0, 0.08, YELLOW], // Capella
  [5.242, -8.2, 0.13, BLUE], // Rigel
  [7.655, 5.22, 0.34, YELLOW], // Procyon
  [5.919, 7.41, 0.5, RED], // Betelgeuse
  [19.846, 8.87, 0.77, WHITE], // Altair
  [4.599, 16.51, 0.85, ORANGE], // Aldebaran
  [16.49, -26.43, 0.96, RED], // Antares
  [13.42, -11.16, 0.97, BLUE], // Spica
  [7.755, 28.03, 1.14, ORANGE], // Pollux
  [22.961, -29.62, 1.16, WHITE], // Fomalhaut
  [20.69, 45.28, 1.25, WHITE], // Deneb
  [10.139, 11.97, 1.35, BLUE], // Regulus
  [6.977, -28.97, 1.5, BLUE], // Adhara
  [7.577, 31.89, 1.58, WHITE], // Castor
  [17.56, -37.1, 1.62, BLUE], // Shaula
  [5.419, 6.35, 1.64, BLUE], // Bellatrix
  [5.438, 28.61, 1.65, BLUE], // Elnath
  [5.603, -1.2, 1.69, BLUE], // Alnilam
  [5.679, -1.94, 1.77, BLUE], // Alnitak
  [5.533, -0.3, 2.23, BLUE], // Mintaka
  [5.796, -9.67, 2.09, BLUE], // Saiph
  [5.585, 9.93, 3.4, BLUE], // Meissa
  [5.588, -5.39, 4.0, WHITE], // Orion Nebula
  [12.9, 55.96, 1.77, WHITE], // Alioth
  [11.062, 61.75, 1.79, ORANGE], // Dubhe
  [13.792, 49.31, 1.86, BLUE], // Alkaid
  [3.405, 49.86, 1.79, YELLOW], // Mirfak
  [7.14, -26.39, 1.83, YELLOW], // Wezen
  [18.403, -34.38, 1.85, WHITE], // Kaus Australis
  [18.35, -29.83, 2.7, ORANGE], // Kaus Media
  [18.466, -25.42, 2.8, ORANGE], // Kaus Borealis
  [19.043, -29.88, 2.6, WHITE], // Ascella
  [18.921, -26.3, 2.05, BLUE], // Nunki
  [18.761, -26.99, 3.2, BLUE], // Phi Sagittarii
  [19.116, -27.67, 3.3, ORANGE], // Tau Sagittarii
  [5.992, 44.95, 1.9, WHITE], // Menkalinan
  [6.628, 16.4, 1.93, WHITE], // Alhena
  [6.378, -17.96, 1.98, BLUE], // Mirzam
  [9.46, -8.66, 1.98, ORANGE], // Alphard
  [2.12, 23.46, 2.0, ORANGE], // Hamal
  [11.818, 14.57, 2.13, WHITE], // Denebola
  [10.333, 19.84, 2.0, ORANGE], // Algieba
  [11.235, 20.52, 2.6, WHITE], // Zosma
  [3.136, 40.96, 2.1, BLUE], // Algol
  [16.006, -22.62, 2.3, BLUE], // Dschubba
  [16.091, -19.8, 2.6, BLUE], // Acrab
  [16.598, -28.22, 2.8, BLUE], // Tau Scorpii
  [16.836, -34.29, 2.3, ORANGE], // Epsilon Scorpii
  [16.864, -38.05, 3.0, BLUE], // Mu Scorpii
  [16.9, -42.36, 3.6, ORANGE], // Zeta Scorpii
  [17.202, -43.24, 3.3, WHITE], // Eta Scorpii
  [17.622, -43.0, 1.86, YELLOW], // Sargas
  [17.512, -37.3, 2.7, BLUE], // Lesath
  [3.791, 24.1, 2.87, BLUE], // Alcyone
  [3.819, 24.05, 3.6, BLUE], // Atlas
  [3.747, 24.11, 3.7, BLUE], // Electra
  [3.763, 24.37, 3.9, BLUE], // Maia
  [3.772, 23.95, 4.1, BLUE], // Merope
  [3.754, 24.47, 4.3, BLUE], // Taygeta
  [20.37, 40.26, 2.2, YELLOW], // Sadr
  [19.512, 27.96, 3.1, ORANGE], // Albireo
  [20.77, 33.97, 2.5, ORANGE], // Gienah (Cygnus)
  [19.75, 45.13, 2.9, BLUE], // Delta Cygni
  [19.771, 10.61, 2.7, ORANGE], // Tarazed
  [23.079, 15.21, 2.5, WHITE], // Markab
  [23.063, 28.08, 2.4, RED], // Scheat
  [0.22, 15.18, 2.8, BLUE], // Algenib
  [0.14, 29.09, 2.1, BLUE], // Alpheratz
  [12.263, -17.54, 2.6, BLUE], // Gienah (Corvus)
  [12.573, -23.4, 2.6, YELLOW], // Kraz
  [12.498, -16.52, 2.9, WHITE], // Algorab
  [12.169, -22.62, 3.0, ORANGE], // Minkar
];

/** Builds the full star field: catalog stars, random faint stars and the Milky Way. */
export function buildStarField(seed: number): Star[] {
  const stars: Star[] = CATALOG.map(([raH, decD, mag, color]) => ({
    ra: raH * 15 * DEG,
    dec: decD * DEG,
    mag,
    color,
    haze: false,
  }));
  const rng = new Rng(seed ^ 0x51a7);
  const tints = [BLUE, WHITE, WHITE, YELLOW, ORANGE];
  for (let i = 0; i < 1400; i++) {
    const dec = Math.asin(rng.range(-0.85, 1));
    stars.push({
      ra: rng.next() * TAU,
      dec,
      // Magnitudes follow roughly the real counts: many more faint stars.
      mag: 6.2 - 3.2 * Math.pow(rng.next(), 2.2),
      color: rng.pick(tints),
      haze: false,
    });
  }
  for (let i = 0; i < 3200; i++) {
    // Concentrate toward the galactic plane and the core in Sagittarius (l = 0).
    const u = rng.next() * 2 - 1;
    const l = Math.sign(u) * Math.pow(Math.abs(u), 1.4) * Math.PI;
    const spread = 0.05 + 0.1 * (1 - Math.abs(l) / Math.PI);
    const b = (rng.next() + rng.next() + rng.next() - 1.5) * spread * 2;
    const eq = galacticToEquatorial(l, b);
    stars.push({
      ra: eq.ra,
      dec: eq.dec,
      mag: 6.5 + rng.next() * 1.5 - 1.2 * (1 - Math.abs(l) / Math.PI),
      color: rng.chance(0.3) ? YELLOW : WHITE,
      haze: true,
    });
  }
  return stars;
}
