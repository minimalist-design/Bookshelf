/** `bookshelf config …`: inspects and updates the config file. */
import { configPath, CONFIG_TEMPLATE, CURRENT_VERSION, expandTilde, fileVersion, tilde, updateConfigFile } from "./configFile.ts";

export const USAGE = `usage:
  bookshelf                          start the server (the first start picks a port in 20000–20999
                                     and saves it in the config)
  bookshelf config version [CONFIG]  show the config's version and the current one
  bookshelf config update [CONFIG]   add new settings to the config and raise its version
                                     (existing settings and values are never changed)
  bookshelf config path              print where the config file is
  bookshelf config template          print the default config
  bookshelf serviceman-info          describe the service as JSON (for ServiceMan and CaddyMan;
                                     caddyman-info is the same command)

config: ${tilde(configPath())}
`;

/** Runs `bookshelf config <args>`; returns the exit code. */
export function configCommand(args: string[]): number {
  const [sub, pathArg, ...extra] = args;
  if (!sub || extra.length > 0) {
    console.error("usage: bookshelf config version|update|path|template [CONFIG]");
    return 2;
  }
  const path = pathArg ? expandTilde(pathArg) : configPath();
  switch (sub) {
    case "path":
      console.log(path);
      return 0;
    case "template":
      process.stdout.write(CONFIG_TEMPLATE);
      return 0;
    case "version": {
      const v = fileVersion(path);
      if (v === null) console.log(`${tilde(path)} does not exist (current version is ${CURRENT_VERSION}; \`bookshelf config update\` creates it)`);
      else if (v < CURRENT_VERSION) console.log(`${tilde(path)}: version ${v}, current is ${CURRENT_VERSION} (\`bookshelf config update\` adds the new settings)`);
      else if (v > CURRENT_VERSION) console.log(`${tilde(path)}: version ${v}, newer than this Bookshelf's ${CURRENT_VERSION}`);
      else console.log(`${tilde(path)}: version ${v} (current)`);
      return 0;
    }
    case "update": {
      const r = updateConfigFile(path);
      if (r.created) console.log(`created ${tilde(path)} from the template (version ${r.newVersion})`);
      else if (r.added.length === 0 && r.oldVersion === r.newVersion) console.log(`${tilde(path)} is up to date (version ${r.newVersion})`);
      else {
        const what = r.added.length > 0 ? `added ${r.added.join(", ")}` : "no new settings";
        console.log(`updated ${tilde(path)}: ${what}; version ${r.oldVersion} → ${r.newVersion}`);
      }
      return 0;
    }
    default:
      console.error(`unknown config command "${sub}"\nusage: bookshelf config version|update|path|template [CONFIG]`);
      return 2;
  }
}
