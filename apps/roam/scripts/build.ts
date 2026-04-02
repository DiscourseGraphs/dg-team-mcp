import { compile } from "./compile.ts";

const main = async () => {
  process.env.NODE_ENV = process.env.NODE_ENV || "production";
  await compile({ watch: false });
};

void main().catch((error) => {
  console.error("Roam plugin build failed:", error);
  process.exit(1);
});
