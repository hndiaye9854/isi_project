import pino from 'pino';

export function createLogger(service) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
