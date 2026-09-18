#!/usr/bin/env node
"use strict";
// Builds dist/ and runs every suite, one after the other (they share CPU-hungry video playback).
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const suites = ["test/unit.test.js", "test/loon-script.test.js", "test/app-mode.test.js", "test/e2e-player.test.js", "test/e2e-mms.test.js", "test/e2e-flows.test.js"];

const build = spawnSync(process.execPath, ["build.js"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite}`);
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=spec", suite], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) failed += 1;
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
