/**
 * Entry point of `bookshelf` (and of the compiled executable): no arguments starts the server, `config …` manages
 * the config file, `serviceman-info` (alias `caddyman-info`) describes the service for ServiceMan and CaddyMan. The
 * server is imported only when it is started, so the other commands have no side effects.
 */
import { configCommand, USAGE } from "./cli.ts";
import { ConfigError } from "./configFile.ts";
import { PortError } from "./listen.ts";
import { SERVICE_INFO_COMMANDS, serviceInfo } from "./serviceInfo.ts";

const [command, ...args] = Bun.argv.slice(2);

try {
  if (command === undefined) {
    await import("./serve.ts");
  } else if (command === "config") {
    process.exit(configCommand(args));
  } else if (SERVICE_INFO_COMMANDS.includes(command) && args.length === 0) {
    process.stdout.write(JSON.stringify(serviceInfo(), null, 2) + "\n");
  } else if (command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
  } else {
    process.stderr.write(`bookshelf: unknown command "${command}"\n\n${USAGE}`);
    process.exit(2);
  }
} catch (err) {
  if (!(err instanceof ConfigError || err instanceof PortError)) throw err;
  console.error(`bookshelf: ${err.message}`);
  process.exit(1);
}
