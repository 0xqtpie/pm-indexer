import { config } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(level: LogLevel): boolean {
  return levelPriority[level] >= levelPriority[config.LOG_LEVEL];
}

function writeLog(level: LogLevel, message: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) {
    return;
  }

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }

  const payload = JSON.stringify(entry);
  if (level === "error") {
    console.error(payload);
  } else {
    console.log(payload);
  }
}

export const logger = {
  debug: (message: string, data?: Record<string, unknown>) =>
    writeLog("debug", message, data),
  info: (message: string, data?: Record<string, unknown>) =>
    writeLog("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) =>
    writeLog("warn", message, data),
  error: (message: string, data?: Record<string, unknown>) =>
    writeLog("error", message, data),
};
