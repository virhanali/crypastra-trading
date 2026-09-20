import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  server: {
    port: 5173,
    // Proxy ke backend agar browser tidak pernah menyentuh Gate.io langsung.
    proxy: {
      "/api": { target: process.env.CRYPASTRA_API ?? "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: process.env.CRYPASTRA_API ?? "http://127.0.0.1:8787", changeOrigin: true },
      "/ws": { target: process.env.CRYPASTRA_WS ?? "ws://127.0.0.1:8787", ws: true },
    },
  },
});
