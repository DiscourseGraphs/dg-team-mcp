import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "apps/roam");
const OUTDIR = path.join(ROOT, "dist");

export const compile = async ({
  watch,
}: {
  watch: boolean;
}) => {
  fs.mkdirSync(OUTDIR, { recursive: true });

  const sharedOptions: esbuild.BuildOptions = {
    absWorkingDir: ROOT,
    entryPoints: ["src/index.ts"],
    outfile: path.join(OUTDIR, "extension.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    sourcemap: process.env.NODE_ENV === "production" ? "external" : "inline",
    minify: process.env.NODE_ENV === "production",
    logLevel: "info",
    loader: {
      ".css": "text",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env.NODE_ENV || "production",
      ),
    },
  };

  if (watch) {
    const context = await esbuild.context(sharedOptions);
    await context.watch();
    console.log("Watching apps/roam/src for changes...");
    return;
  }

  await esbuild.build(sharedOptions);

  for (const filename of ["README.md", "package.json"]) {
    const source = path.join(ROOT, filename);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(OUTDIR, filename));
    }
  }
};
