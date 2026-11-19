/**
 * `bookshelf service-info`: describes the service as JSON so ServiceMan (the systemd unit) and CaddyMan (the reverse
 * proxy site) can fill in their forms. It reads only the config file: no network, and it works before the first start.
 */
import { configPath, readConfigFile, tilde } from "./configFile.ts";

export interface ServiceInfo {
  /** Format version; raised only when a field is renamed or removed. */
  service_info: 1;
  name: string;
  description: string;
  /** What follows the binary in ExecStart=. */
  args: string[];
  /** The configured port, or null before the first start assigns one. */
  port: number | null;
  /** Answers 200 while the server is up. */
  health_path: string;
  config_path: string;
  /** null for a program without secrets. */
  env_file: string | null;
  /** Suggested values for the CaddyMan site. */
  proxy: { https: boolean; trusted_only: boolean; redirect_root: string };
}

export function serviceInfo(path: string = configPath()): ServiceInfo {
  const port = readConfigFile(path).port;
  return {
    service_info: 1,
    name: "bookshelf",
    description: "Bookshelf ebook library",
    args: [],
    port: port ? port : null,
    health_path: "/api/health",
    config_path: tilde(path),
    env_file: "~/.secrets/bookshelf.env",
    proxy: { https: true, trusted_only: true, redirect_root: "" },
  };
}
