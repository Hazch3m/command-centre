import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// `npm run tauri dev` / `tauri build` use the real backend (Rust + SQLite).
// `npm run preview:browser` swaps in an in-browser SQLite (sql.js) so the UI
// can be developed and tested in a normal browser. That harness never ships.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@backend": resolve(__dirname, mode === "browser" ? "src/core/backend.browser.ts" : "src/core/backend.tauri.ts"),
    },
  },
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        quickadd: resolve(__dirname, "quickadd.html"),
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
}));
