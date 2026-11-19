/**
 * Entry point of `bookshelf` (and of the compiled executable): no arguments starts the server, `config …` manages
 * the config file. The server is imported only when it is started, so `config` commands have no side effects.
 */
import { configCommand, USAGE } from "./cli.ts";
import { ConfigError } from "./configFile.ts";

const [command, ...args] = Bun.argv.slice(2);

try {
  if (command === undefined) {
    await import("./serve.ts");
  } else if (command === "config") {
    process.exit(configCommand(args));
  } else if (command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
  } else {
    process.stderr.write(`bookshelf: unknown command "${command}"\n\n${USAGE}`);
    process.exit(2);
  }
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`bookshelf: ${err.message}`);
  process.exit(1);
}
