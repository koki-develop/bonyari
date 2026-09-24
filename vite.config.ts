import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs, so the collection works from any sub-path.
  base: "./",
  input: {
    main: resolve(import.meta.dirname, "index.html"),
    nightTrain: resolve(import.meta.dirname, "night-train/index.html"),
  },
});
