// Minimal structured logger. Never log tokens or full initData.
export const log = {
  info(msg: string, extra?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "info", msg, ...extra }));
  },
  warn(msg: string, extra?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: "warn", msg, ...extra }));
  },
  error(msg: string, err?: unknown, extra?: Record<string, unknown>) {
    const errPart = err instanceof Error ? { err: err.message, stack: err.stack } : { err };
    console.error(JSON.stringify({ level: "error", msg, ...errPart, ...extra }));
  },
};
