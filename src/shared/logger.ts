import pino from "pino";

// Pretty in TTY, JSON otherwise. Pino's transport handles both cases.
const isPretty = process.stdout.isTTY && process.env.NODE_ENV !== "production";
export const logger = pino(
  isPretty
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {},
);

export function childLogger(name: string) {
  return logger.child({ component: name });
}
