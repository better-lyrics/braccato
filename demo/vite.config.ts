import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  server: {
    port: 5173,
    // `vite --mode bench`, which `pnpm bench` runs: cross-origin isolation, without which browsers
    // round `performance.now()` to 100 µs, coarser than most of what a frame is split into.
    // `credentialless` still lets the pages load their fonts from other origins.
    headers:
      mode === "bench"
        ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" }
        : undefined,
  },
  // The page prints the element's constructor either side of the import, to show a reader what the
  // tag upgraded into. Minified, that reads `HTMLElement -> le`, which demonstrates nothing. This
  // costs a few bytes and keeps the row honest.
  esbuild: {
    keepNames: true,
  },
}));
