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

function run() {
  let inputDir = process.env.MAKEFUN_INPUT_DIR;
  if (inputDir === undefined) inputDir = '/input';
  let outputDir = process.env.MAKEFUN_OUTPUT_DIR;
  if (outputDir === undefined) outputDir = '/output';
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
  let html = [];
  let idx = 0;
  while (idx < cases.length) {
    html[html.length] = parse(cases[idx].markdown);
    idx += 1;
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

run();
