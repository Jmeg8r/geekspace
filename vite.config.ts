import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// WHAT: Vite config for the Electron renderer.
// WHY: base "./" is required so the production build loads via file:// inside Electron.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
