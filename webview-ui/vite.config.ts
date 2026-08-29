import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      // Three entry points: the chat SPA (index.html), the learner-profile
      // panel (profile.html), and the memory-graph panel (memoryGraph.html).
      // Relative paths resolve against the webview-ui cwd. `[name]` is the
      // input key, so the chat bundle stays `assets/index.js`, the profile
      // bundle becomes `assets/profile.js`, and the graph bundle becomes
      // `assets/memoryGraph.js`.
      input: {
        index: "index.html",
        profile: "profile.html",
        memoryGraph: "memoryGraph.html",
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
