// Winston logger: console plus a daily-rotated JSON file under <DATA_DIR>/logs (same as before).

import path from 'node:path';
import winston from 'winston';
import 'winston-daily-rotate-file';

export type Logger = winston.Logger;

export function createLogger(dataDir: string, level: string): Logger {
    const rotate = new winston.transports.DailyRotateFile({
        filename: path.join(dataDir, 'logs', '%DATE%.log'),
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    });
    return winston.createLogger({
        level,
        format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
        defaultMeta: { service: 'messydesk' },
        transports: [
            new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) }),
            rotate,
        ],
    });
}
