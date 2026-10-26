import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: projectRoot,
  publicDir: resolve(projectRoot, "public"),
  cacheDir: resolve(projectRoot, "node_modules/.vite"),
  optimizeDeps: {
    entries: [resolve(projectRoot, "index.html")]
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
    fs: {
      strict: true,
      allow: [projectRoot]
    },
    watch: { ignored: ["**/src-tauri/**", "**/node_modules/**"] }
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2021" },
  plugins: [
    react(),
    {
      name: "dkn-vite-root-diagnostic",
      configResolved(config) {
        console.info("[DKN Vite] startup paths", {
          cwd: process.cwd(),
          root: config.root,
          configFile: config.configFile
        });
      }
    }
  ]
});
