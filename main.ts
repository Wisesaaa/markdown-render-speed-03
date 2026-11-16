// Driver for the markdown-render-speed entry.
//
// The harness runs `node /bot/main.ts`. It reads every case from
// /input/cases.json (a JSON array of {id, markdown}), renders each one
// alone with parse() from parse.js, and writes /output/html.json: a JSON
// array of the HTML strings, one per case and in the cases' order.
// Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

// Resolve one directory: the MAKEFUN_* environment override wins,
// otherwise the container path.
function resolveDir(envName, fallback) {
  let value = process.env[envName];
  return value === undefined ? fallback : value;
}

function loadCases(inputDir) {
  let raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  return JSON.parse(raw);
}

function renderCases(cases) {
  return cases.map((entry) => parse(entry.markdown));
}

function saveHtml(outputDir, html) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

function main() {
  let inputDir = resolveDir('MAKEFUN_INPUT_DIR', '/input');
  let outputDir = resolveDir('MAKEFUN_OUTPUT_DIR', '/output');
  let cases = loadCases(inputDir);
  let html = renderCases(cases);
  saveHtml(outputDir, html);
}

main();
