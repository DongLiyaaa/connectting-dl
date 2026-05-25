import { nowIso } from "./utils.js";

export class Logger {
  info(message, extra = undefined) {
    this.print("INFO", message, extra);
  }

  warn(message, extra = undefined) {
    this.print("WARN", message, extra);
  }

  error(message, extra = undefined) {
    this.print("ERROR", message, extra);
  }

  print(level, message, extra) {
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    process.stdout.write(`${nowIso()} ${level} ${message}${suffix}\n`);
  }
}
