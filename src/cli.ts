import { parseCliArgs, USAGE } from "./cli-args.js";

function main(argv: readonly string[]): number {
  const cmd = parseCliArgs(argv);
  switch (cmd.kind) {
    case "help":
      console.log(USAGE);
      return 0;
    case "invalid":
      console.error(`error: ${cmd.message}\n\n${USAGE}`);
      return 2;
    case "run":
    case "eval":
      // Implemented in Phases 6 and 7.
      console.error(`error: "${cmd.kind}" is not implemented yet`);
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
