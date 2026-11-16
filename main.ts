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

// Resolve the input/output directories, honouring the MAKEFUN_*
// environment overrides and falling back to the container paths.
function dirs() {
  let inputDir = process.env.MAKEFUN_INPUT_DIR;
  if (inputDir === undefined) inputDir = '/input';
  let outputDir = process.env.MAKEFUN_OUTPUT_DIR;
  if (outputDir === undefined) outputDir = '/output';
  return { inputDir, outputDir };
}

function main() {
  let { inputDir, outputDir } = dirs();
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
  let html = new Array(cases.length);
  for (let idx = 0; idx < cases.length; idx += 1) {
    html[idx] = parse(cases[idx].markdown);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
