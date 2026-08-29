import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      // Two entry points: the chat SPA (index.html) and the learner-profile
      // panel (profile.html). Relative paths resolve against the webview-ui
      // cwd. `[name]` is the input key, so the chat bundle stays
      // `assets/index.js` and the profile bundle becomes `assets/profile.js`.
      input: {
        index: "index.html",
        profile: "profile.html",
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
