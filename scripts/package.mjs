// Builds the prebuilt package (release archive): releases/learnharness-git-<version>.zip
// holding learnharness-git/dist/**, ready to extract into the LearnHarness plugins folder.
// Node built-ins only (no zip tool needed). Run `npm run build` first (the npm script does).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const dist = path.join(root, "dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) throw new Error("dist/ is not built; run npm run build.");

function files(dir, prefix = "") {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) =>
			entry.isDirectory()
				? files(path.join(dir, entry.name), `${prefix}${entry.name}/`)
				: [{ name: `${prefix}${entry.name}`, file: path.join(dir, entry.name) }],
		);
}

// Fixed timestamp (1980-01-01) so the same build gives the same archive.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const local = [];
const central = [];
let offset = 0;
for (const { name, file } of files(dist)) {
	const data = fs.readFileSync(file);
	const packed = zlib.deflateRawSync(data, { level: 9 });
	const entryName = Buffer.from(`${manifest.id}/dist/${name}`, "utf8");
	const crc = zlib.crc32(data);
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(0x0800, 6); // UTF-8 names
	header.writeUInt16LE(8, 8); // deflate
	header.writeUInt16LE(DOS_TIME, 10);
	header.writeUInt16LE(DOS_DATE, 12);
	header.writeUInt32LE(crc, 14);
	header.writeUInt32LE(packed.length, 18);
	header.writeUInt32LE(data.length, 22);
	header.writeUInt16LE(entryName.length, 26);
	local.push(header, entryName, packed);
	const record = Buffer.alloc(46);
	record.writeUInt32LE(0x02014b50, 0);
	record.writeUInt16LE(20, 4);
	record.writeUInt16LE(20, 6);
	record.writeUInt16LE(0x0800, 8);
	record.writeUInt16LE(8, 10);
	record.writeUInt16LE(DOS_TIME, 12);
	record.writeUInt16LE(DOS_DATE, 14);
	record.writeUInt32LE(crc, 16);
	record.writeUInt32LE(packed.length, 20);
	record.writeUInt32LE(data.length, 24);
	record.writeUInt16LE(entryName.length, 28);
	record.writeUInt32LE(offset, 42);
	central.push(record, entryName);
	offset += header.length + entryName.length + packed.length;
}
const centralSize = central.reduce((sum, b) => sum + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const out = path.join(root, "releases", `${manifest.id}-${manifest.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...local, ...central, end]));
console.log(`Packaged ${path.relative(root, out)} (${central.length / 2} files)`);
