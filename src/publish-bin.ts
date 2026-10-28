#!/usr/bin/env node
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { PACKAGE_ROOT, readConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { createLinkedIn } from "./lib.js";
import { publish } from "./publish.js";
import { redactString } from "./sanitize.js";

/**
 * npm run publish -- <text file> [--image <png|jpg>] [--alt "…"] [--dry-run]
 *
 * Run it in your own terminal: it shows exactly what will be posted and asks for a code.
 * Keep the text files in content/ (gitignored).
 */

const out = (line: string) => process.stdout.write(`${redactString(line)}\n`);

function parseArgs(argv: string[]): { textFile?: string; imageFile?: string; altText?: string; dryRun: boolean } {
  const r: { textFile?: string; imageFile?: string; altText?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") r.dryRun = true;
    else if (a === "--image" || a === "--alt") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      if (a === "--image") r.imageFile = v;
      else r.altText = v;
    } else if (a.startsWith("--")) throw new Error(`Unknown option ${a}`);
    else if (r.textFile === undefined) r.textFile = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  return r;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.textFile) {
    out('usage: npm run publish -- <text file> [--image <png|jpg>] [--alt "…"] [--dry-run]');
    return 2;
  }
  loadDotEnv();
  const config = readConfig(process.env);
  const { client, tokens } = createLinkedIn(config);
  const ask = process.stdin.isTTY
    ? async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }
    : undefined;
  const r = await publish(
    { textFile: resolve(args.textFile), imageFile: args.imageFile && resolve(args.imageFile), altText: args.altText, dryRun: args.dryRun },
    { client, tokens, organizationId: config.organizationId, ask, out, logFile: resolve(PACKAGE_ROOT, "content", "publications.jsonl") },
  );
  return r.status === "published" || r.status === "already_posted" || r.status === "dry_run" ? 0 : 1;
}

// exitCode, not process.exit(): exiting while fetch's sockets close crashes libuv on Windows
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`[linkedin-mcp] ${redactString(err instanceof Error ? err.message : String(err))}\n`);
    process.exitCode = 1;
  },
);
