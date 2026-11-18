// Token Radar — entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, builds the radar-2 board, and writes the
// output tree the gate checks: board.json, data.js, dashboard/, screenshots/
// and dossier.json (via the vendored buildDossier). Deterministic: two runs
// write the same bytes.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|dir>
//   (no --input: reads /input/snapshot.json; no MAKEFUN_OUTPUT_DIR: /output)

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildDossier } from "./vendor/makefun-board.ts";
import { buildBoard, dataJs, parseSnapshot, validateBoard } from "./lib/model.ts";

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else cpSync(s, d);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const inputArg = argValue(argv, "--input");
  let inputPath = inputArg ?? "/input/snapshot.json";
  if (existsSync(inputPath) && statSync(inputPath).isDirectory()) {
    inputPath = join(inputPath, "snapshot.json");
  }
  const outDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? "/output");
  const repoRoot = resolve(import.meta.dirname);

  const snapshot = parseSnapshot(readFileSync(inputPath, "utf8"));
  const data = buildBoard(snapshot);
  const errors = validateBoard(data, snapshot);
  if (errors.length > 0) {
    throw new Error("board validation failed:\n" + errors.slice(0, 20).join("\n"));
  }

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });

  writeFileSync(join(outDir, "board.json"), JSON.stringify({ rows: data.rows }, null, 2) + "\n", "utf8");
  writeFileSync(join(outDir, "data.js"), dataJs(data), "utf8");
  copyTree(join(repoRoot, "dashboard"), join(outDir, "dashboard"));
  copyTree(join(repoRoot, "screenshots"), join(outDir, "screenshots"));

  const dossier = buildDossier(outDir, { text_max_bytes: 65536 });
  writeFileSync(join(outDir, "dossier.json"), dossier);

  const top = data.rows[0];
  const last = data.rows[data.rows.length - 1];
  console.log(`token-radar radar-2: ${data.rows.length} rows, watchlist ${data.counts.watchlist}/40, ` +
    `Farm ${data.counts.farm} / Thin ${data.counts.thin} / Skip ${data.counts.skip}, live ${data.counts.live}`);
  console.log(`implied ${top.slug} $${top.implied_value_usd.toLocaleString("en-US")} -> ` +
    `${last.slug} $${last.implied_value_usd.toLocaleString("en-US")}`);
  console.log(`blind test: median abs error ${data.model.blind.median_abs_error_pct}%, ` +
    `${data.model.blind.within_2x_pct}% within 2x, ${data.model.blind.within_3x_pct}% within 3x ` +
    `(${data.model.blind.held_out} held out)`);
  console.log(`wrote ${outDir} (dossier ${dossier.length} bytes)`);
}

main();
