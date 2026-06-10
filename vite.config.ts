import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// WHAT: Vite config for the Electron renderer.
// WHY: base "./" is required so the production build loads via file:// inside Electron.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  server: {
    // WHY host pin: on this Node, "localhost" binds IPv6-only ([::1]), but the
    // dev script's wait-on polls 127.0.0.1 — without this the Electron window
    // never launches.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
