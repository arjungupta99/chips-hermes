#!/usr/bin/env node
/**
 * The bridge as one file, the way `chips connect` runs it (Chips ADR 0218): `dist/main.js` with
 * everything it imports bundled in, so the package has no dependencies to install, and
 * `dist/THIRD-PARTY-NOTICES.md` with the licence of each package that went into it. The same file
 * in each Chips bridge.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const own = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

const built = await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(here, "dist", "main.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // A CommonJS package inside an ESM bundle may `require` Node's own modules as it loads.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __bridgeRequire } from "node:module";',
      "const require = __bridgeRequire(import.meta.url);",
    ].join("\n"),
  },
  metafile: true,
  logLevel: "warning",
});

/** The package an input belongs to: the folder after its last `node_modules/`. */
function packageRoot(input) {
  const at = input.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const rest = input.slice(at + "node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return join(here, input.slice(0, at), "node_modules", ...name);
}

const LICENCE = /^(licen[cs]e|copying|notice)(\.|$)/i;

const carried = [
  ...new Set(Object.keys(built.metafile.inputs).map(packageRoot).filter(Boolean)),
].map((root) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const texts = readdirSync(root)
    .filter((file) => LICENCE.test(file))
    .map((file) => readFileSync(join(root, file), "utf8").trim());
  const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
  return { name: manifest.name, version: manifest.version, license, texts };
});
carried.sort((a, b) => a.name.localeCompare(b.name));

const notices = [
  "# Third-party notices",
  "",
  `\`dist/main.js\` in ${own.name} ${own.version} carries these packages, bundled in. Each one's`,
  "licence follows.",
  ...carried.flatMap((each) => [
    "",
    `## ${each.name} ${each.version} (${each.license ?? "licence not stated"})`,
    "",
    ...(each.texts.length > 0 ? each.texts : ["Its package carries no licence file."]),
  ]),
  "",
].join("\n");

mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "THIRD-PARTY-NOTICES.md"), notices);
if (!existsSync(join(here, "dist", "main.js"))) throw new Error("dist/main.js was not written");
