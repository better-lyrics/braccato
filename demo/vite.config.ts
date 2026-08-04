import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
  },
  // The page prints the element's constructor either side of the import, to show a reader what the
  // tag upgraded into. Minified, that reads `HTMLElement -> le`, which demonstrates nothing. This
  // costs a few bytes and keeps the row honest.
  esbuild: {
    keepNames: true,
  },
});
