import { compile } from "./compile.ts";

const main = async () => {
  process.env.NODE_ENV = "development";
  await compile({ watch: true });
};

void main().catch((error) => {
  console.error("Roam plugin dev build failed:", error);
  process.exit(1);
});
