#!/usr/bin/env node
import { run } from "../src/cli.mjs";

const code = await run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env });
process.exitCode = code;
