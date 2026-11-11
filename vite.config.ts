import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pwa-icon.svg"],
      manifest: {
        name: "Daily Data Logger",
        short_name: "Data Logger",
        description: "An offline-first daily data logger.",
        theme_color: "#0c111b",
        background_color: "#0c111b",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/pwa-icon.svg", sizes: "192x192", type: "image/svg+xml", purpose: "any" },
          { src: "/pwa-icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) return "react-vendor";
          if (id.includes("/node_modules/motion/")) return "motion-vendor";
          if (id.includes("/node_modules/dexie/")) return "storage-vendor";
          return undefined;
        },
      },
    },
  },
});
