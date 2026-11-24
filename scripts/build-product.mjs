import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { timedSync } from "./dev-metrics.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
export function typecheckArgs(root, env = process.env) {
  const args = [join(root, "node_modules/typescript/bin/tsc"), "-noEmit", "-skipLibCheck"];
  if (env.CI !== "true" && env.VAM_CLEAN_BUILD !== "1") args.push("--incremental", "--tsBuildInfoFile", join(root, "node_modules/.cache/vam/tsconfig.tsbuildinfo"));
  return args;
}
export function buildProduct(env = process.env) {
  const run = (stage, args) => timedSync(stage, () => {
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env });
    if (result.error || result.status !== 0) throw new Error(`Build failed at ${stage}`, { cause: result.error });
  });
  const args = typecheckArgs(root, env);
  if (args.includes("--incremental")) mkdirSync(join(root, "node_modules/.cache/vam"), { recursive: true });
  run("build-viewer", ["scripts/build-viewer.mjs"]);
  run("typecheck", args);
  run("bundle", ["esbuild.config.mjs", "production"]);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) buildProduct();
