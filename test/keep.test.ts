/**
 * The service keep writes names the bridge as it was started. `chips connect` starts a bridge at
 * `<bridge>/package/dist/main.js`, where `package` is a link to the release in use
 * (`package-1.0.34`), and moves that link when it updates the bridge. Node resolves the link in
 * `import.meta.url`, so keep used to write the release's own folder into the service, which then
 * went on running that release after each update, and couldn't start at all once the folder was
 * removed.
 *
 * Nothing of this machine's is read or written: keep's file goes to a home made for the test, and
 * `launchctl`, `systemctl` and `loginctl` are stand-ins on a PATH of its own that only answer.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { build } from "esbuild";
import { asStarted } from "../src/keep.ts";

const scratch = mkdtempSync(join(tmpdir(), "chips-keep-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A release unpacked as `package-<version>` in `folder`, with `package` a link to it. */
function release(folder: string, version: string, main = "// main\n"): string {
  mkdirSync(join(folder, `package-${version}`, "dist"), { recursive: true });
  writeFileSync(join(folder, `package-${version}`, "dist", "main.js"), main);
  rmSync(join(folder, "package"), { force: true });
  symlinkSync(`package-${version}`, join(folder, "package"));
  return join(folder, `package-${version}`);
}

it("names the link it was started through, not the release behind it", () => {
  const folder = join(scratch, "names");
  const real = release(folder, "1.0.1");
  assert.deepEqual(asStarted(real, join(real, "dist", "main.js"), join(folder, "package", "dist", "main.js")), {
    root: join(folder, "package"),
    file: join(folder, "package", "dist", "main.js"),
  });
  // Started at the release's own folder, that is what it names.
  assert.deepEqual(asStarted(real, join(real, "dist", "main.js"), join(real, "dist", "main.js")), {
    root: real,
    file: join(real, "dist", "main.js"),
  });
});

it("keeps its own path for a command linked to it, another file, or nothing said", () => {
  const folder = join(scratch, "own");
  const real = release(folder, "1.0.1");
  const file = join(real, "dist", "main.js");
  // `npm install -g` links `bin/chips-…` to the bundle: that is no place to run it from.
  mkdirSync(join(folder, "bin"));
  symlinkSync(file, join(folder, "bin", "chips-bridge"));
  const own = { root: real, file };
  assert.deepEqual(asStarted(real, file, join(folder, "bin", "chips-bridge")), own);
  // A checkout runs `src/main.ts`, which isn't this file.
  assert.deepEqual(asStarted(real, file, join(folder, "package", "src", "main.ts")), own);
  // A file of the same name somewhere else.
  release(join(scratch, "other"), "1.0.1");
  assert.deepEqual(asStarted(real, file, join(scratch, "other", "package", "dist", "main.js")), own);
  assert.deepEqual(asStarted(real, file, join(folder, "gone", "dist", "main.js")), own);
  assert.deepEqual(asStarted(real, file, undefined), own);
  assert.deepEqual(asStarted(real, file, ""), own);
});

it("writes the link into the service it keeps, for its program and its folder", async () => {
  const home = join(scratch, "home");
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  for (const command of ["launchctl", "systemctl", "loginctl"]) {
    writeFileSync(join(bin, command), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, command), 0o755);
  }
  // keep as the bundle carries it, in a release behind a link, as `chips connect` unpacks it.
  const folder = join(scratch, "bridges", "chipschat-test");
  const real = release(folder, "1.0.1");
  await build({
    stdin: {
      contents: [
        `import { keepIfAsked } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "keep.ts"))};`,
        'keepIfAsked("chat.chips.test-keep", "http://127.0.0.1:9", [], (line) => console.log(line));',
      ].join("\n"),
      resolveDir: join(import.meta.dirname, ".."),
      loader: "ts",
    },
    outfile: join(real, "dist", "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    banner: { js: 'import { createRequire as __r } from "node:module"; const require = __r(import.meta.url);' },
    logLevel: "warning",
  });
  const started = join(folder, "package", "dist", "main.js");
  const ran = spawnSync(process.execPath, [started, "--keep"], {
    cwd: join(folder, "package"),
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, CHIPS_NODE: process.execPath },
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  const written = [
    join(home, "Library", "LaunchAgents", "chat.chips.test-keep.plist"),
    join(home, ".config", "systemd", "user", "chat.chips.test-keep.service"),
  ].find((path) => existsSync(path));
  assert.ok(written !== undefined, `no service was written:\n${ran.stdout}\n${ran.stderr}`);
  const service = readFileSync(written, "utf8");
  assert.ok(service.includes(started), service);
  assert.ok(
    service.includes(`<string>${join(folder, "package")}</string>`) ||
      service.includes(`WorkingDirectory=${join(folder, "package")}\n`),
    service,
  );
  assert.ok(!service.includes("package-1.0.1"), service);
});
