import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const version = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Pass an exact release tag such as 0.36.1.");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== version) throw new Error(`Tag ${version} does not match manifest ${manifest.version}.`);
const output = `release-dist/visual-agent-map-${version}-source.tar.gz`;
const tar = execFileSync("git", ["archive", "--format=tar", `--prefix=visual-agent-map-${version}/`, version], { maxBuffer: 256 * 1024 * 1024 });
const archive = gzipSync(tar, { level: 9, mtime: 0 });
const digest = createHash("sha256").update(archive).digest("hex");
mkdirSync("release-dist", { recursive: true });
writeFileSync(output, archive);
writeFileSync(`${output}.sha256`, `${digest}  visual-agent-map-${version}-source.tar.gz\n`);
process.stdout.write(`Prepared ${output} (${archive.length} bytes, SHA-256 ${digest})\n`);
