// Bundles the frontend (ESM) and backend (CommonJS) straight into dist/.
// Refuses to touch a symlinked dist/ or one that contains plugin data.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
try {
	if (fs.lstatSync(output).isSymbolicLink()) throw new Error("Refusing to build into a linked directory.");
	if (fs.existsSync(path.join(output, "data"))) throw new Error("Refusing to build over plugin data in dist/data.");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
const common = {
	bundle: true,
	target: "es2022",
	minify: true,
	legalComments: "eof",
	logLevel: "warning",
	absWorkingDir: root,
};
await build({ ...common, entryPoints: { main: "src/main.ts" }, outdir: output, format: "esm", platform: "browser" });
await build({
	...common,
	entryPoints: ["src/backend.ts"],
	outfile: path.join(output, "backend.cjs"),
	format: "cjs",
	platform: "node",
});
for (const [from, to] of [
	["manifest.json", "manifest.json"],
	["src/styles.css", "styles.css"],
	["README.md", "README.md"],
	["LICENSE", "LICENSE"],
]) {
	if (fs.existsSync(path.join(root, from))) fs.copyFileSync(path.join(root, from), path.join(output, to));
}
console.log(`Built ${output}`);
