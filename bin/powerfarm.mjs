#!/usr/bin/env node
import { main } from "../src/main.mjs";

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
