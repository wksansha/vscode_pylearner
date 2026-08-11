const esbuild = require("esbuild");

const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const config = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(config);
    console.log("Build complete.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});