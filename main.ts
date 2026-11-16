// Driver for the markdown-render-speed entry.
//
// The harness runs `node /bot/main.ts`. It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one
// alone with parse() from parse.js, and writes /output/html.json: a JSON
// array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output.
//
// The driver is deliberately thin: it resolves the two directories,
// loads the cases, renders each one, and writes the results. All
// rendering lives in parse.js.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// Resolve one directory: the MAKEFUN_* environment override wins,
// otherwise the container path. An explicitly set (even empty)
// variable wins over the fallback.
function resolveDir(envName, fallback) {
  let value = process.env[envName];
  if (value !== undefined) return value;
  return fallback;
}

// Load the cases file: a JSON array of {id, markdown}.
function loadCases(inputDir) {
  let casesPath = join(inputDir, 'cases.json');
  let raw = readFileSync(casesPath, 'utf8');
  return JSON.parse(raw);
}

// Render every case to its HTML string, in the cases' order.
function renderCases(cases) {
  let html = [];
  for (let idx = 0; idx < cases.length; idx += 1) {
    html.push(parse(cases[idx].markdown));
  }
  return html;
}

// Write the rendered HTML strings as a JSON array.
function saveHtml(outputDir, html) {
  mkdirSync(outputDir, { recursive: true });
  let outPath = join(outputDir, 'html.json');
  writeFileSync(outPath, JSON.stringify(html));
}

function main() {
  let inputDir = resolveDir('MAKEFUN_INPUT_DIR', '/input');
  let outputDir = resolveDir('MAKEFUN_OUTPUT_DIR', '/output');
  let cases = loadCases(inputDir);
  let html = renderCases(cases);
  saveHtml(outputDir, html);
}

main();
