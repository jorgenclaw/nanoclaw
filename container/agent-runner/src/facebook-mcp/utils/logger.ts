const createLogger = (name: string) => {
  const log = (level: string, ...args: unknown[]) =>
    console.error(`[${name}:${level}]`, ...args);
  return {
    info: (...args: unknown[]) => log("INFO", ...args),
    warn: (...args: unknown[]) => log("WARN", ...args),
    error: (...args: unknown[]) => log("ERROR", ...args),
    debug: (...args: unknown[]) => log("DEBUG", ...args),
  };
};

export { createLogger };
