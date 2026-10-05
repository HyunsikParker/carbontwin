import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("./web"),
  base: "./",
  build: { outDir: here("./dist"), emptyOutDir: true, target: "es2022" },
  server: { fs: { allow: [here(".")] } },
});
