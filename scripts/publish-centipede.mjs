#!/usr/bin/env node
// Publishes the Centipede launcher from its single source of truth.
//
// The launcher used to be edited in three places by hand (the Surge bundle, the
// GitHub Pages mirror repository, and this repository's own copy that the build
// publishes with the catalogue), and the copies drifted apart. Now
// games/centipede-arcade/index.html is the only copy: the build ships it with
// the catalogue and this script copies it to the other two hosts, where the
// romset and the EmulatorJS runtime sit next to it.
//
// Usage:
//   node scripts/publish-centipede.mjs              copy to Surge and the mirror
//   node scripts/publish-centipede.mjs --check      fail if any copy has drifted
//   node scripts/publish-centipede.mjs --deploy     copy, then Surge + git push
//
// --workspace <dir> points at the directory holding surge-site/ and gh-mirror/
// (default: the parent of this repository).

import { existsSync, readFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes("--" + name);
const option = (name, fallback) => {
  const at = args.indexOf("--" + name);
  return at === -1 ? fallback : args[at + 1];
};

const workspace = resolve(option("workspace", dirname(repoRoot)));
const check = flag("check");
const deploy = flag("deploy");

const source = join(repoRoot, "games", "centipede-arcade", "index.html");
const targets = [
  { label: "Surge bundle", file: join(workspace, "surge-site", "centipede", "index.html") },
  { label: "Pages mirror", file: join(workspace, "gh-mirror", "centipede", "index.html") },
];
// Both files were byte-for-byte duplicates of centtime.zip; the launcher names
// neither, so they only ever wasted space in the published bundles.
const staleFiles = ["rom.zip", "centiped.zip"];

if (!existsSync(source)) {
  console.error("No launcher at " + source);
  process.exit(1);
}
const canonical = readFileSync(source);
let drifted = 0;

for (const target of targets) {
  const dir = dirname(target.file);
  if (!existsSync(dir)) {
    console.error(target.label + ": no directory at " + dir);
    console.error("Pass --workspace with the folder that holds surge-site/ and gh-mirror/.");
    process.exit(1);
  }
  const current = existsSync(target.file) ? readFileSync(target.file) : null;
  const same = current && current.equals(canonical);
  if (same) console.log(target.label + ": already matches");
  else if (current) {
    drifted++;
    console.log(target.label + ": differs from the source (" + current.length + " vs " + canonical.length + " bytes)");
  } else console.log(target.label + ": missing");
  if (!check && !same) {
    copyFileSync(source, target.file);
    console.log(target.label + ": updated");
  }
  for (const name of staleFiles) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    if (check) {
      drifted++;
      console.log(target.label + ": stale " + name + " still present (" + size + " bytes)");
      continue;
    }
    rmSync(path);
    console.log(target.label + ": removed stale " + name + " (" + size + " bytes)");
  }
}

if (check) {
  if (drifted) {
    console.error("Centipede launcher copies are out of sync; run without --check to fix.");
    process.exit(1);
  }
  console.log("Centipede launcher copies match; no stale archives.");
  process.exit(0);
}

if (!deploy) {
  console.log("Copied. Re-run with --deploy to publish to Surge and push the mirror.");
  process.exit(0);
}

const run = (command, commandArgs, cwd) => {
  console.log("$ " + [command, ...commandArgs].join(" "));
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(command + " exited with " + result.status);
    process.exit(result.status || 1);
  }
};

const surgeSite = join(workspace, "surge-site");
run("surge", [surgeSite, "seuss-arcade-games.surge.sh"], workspace);
run("surge", [join(surgeSite, "centipede"), "seuss-centipede.surge.sh"], workspace);

const mirror = join(workspace, "gh-mirror");
const git = (gitArgs) =>
  spawnSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=damonrosshutchins-boop", "-c", "user.email=damonrosshutchins@icloud.com", ...gitArgs], {
    cwd: mirror,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
if (git(["add", "-A"]).status !== 0) process.exit(1);
const pending = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: mirror });
if (pending.status === 0) {
  console.log("Pages mirror: nothing to commit");
} else {
  const message = "Sync the Centipede launcher from the arcade\n\nCopied by scripts/publish-centipede.mjs, which owns the only copy of the\nlauncher and drops the duplicate rom archives.";
  const commit = git(["commit", "-q", "-m", message]);
  if (commit.status !== 0) process.exit(commit.status || 1);
  if (git(["push", "-q", "origin", "main"]).status !== 0) process.exit(1);
  console.log("Pages mirror: pushed");
}
console.log("Published.");
