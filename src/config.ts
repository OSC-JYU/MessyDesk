// Every environment variable the backend reads, in one place. Names and defaults are the same as
// in the old backend (src/env.mjs and the scattered process.env reads), plus the new ones that
// plan/decisions.md introduced (SERVICE_TOKEN, SERVICE_AUTH_LEGACY_MAIL, LEGACY_ARCADEDB).

import path from 'node:path';

function str(name: string, fallback: string): string {
    const value = process.env[name];
    return value === undefined || value === '' ? fallback : value;
}

function num(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && process.env[name] !== '' && process.env[name] !== undefined ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export interface Config {
    port: number;
    development: boolean;
    devUser: string;
    logLevel: string;
    apiUrl: string;
    dataDir: string;
    dbName: string;
    db: { url: string; user: string; password: string | undefined; legacy: boolean; writeRetries: number; backoffBaseMs: number; backoffMaxMs: number };
    solr: { url: string; core: string };
    nomad: { enabled: boolean; url: string; podman: boolean };
    diskQuotaGb: number;
    projectExpirationDays: number;
    serviceToken: string;
    serviceAuthLegacyMail: boolean;
    serviceRegistryPath: string;
    consumerTtlSeconds: number;
    queue: {
        dbPath: string;
        maxAttempts: number;
        leaseSeconds: number;
        keepFailedMinutes: number;
        sweeperEnabled: boolean;
        sweeperIntervalSeconds: number;
        sweeperDoneCancelledMinutes: number;
        batchAbortConsecutive: number;
        batchAbortPercent: number;
        logContext: boolean;
    };
    setZipJobTtlMs: number;
    maxVersionTextBytes: number;
    help: { bundleMaxFiles: number; archiveMaxBytes: number; archiveMaxEntries: number };
    publicDir: string;
    helpDir: string;
    filtersDir: string;
}

export function loadConfig(root = process.cwd()): Config {
    const dbName = str('DB_NAME', 'messydesk');
    const dbHost = str('DB_HOST', 'http://127.0.0.1');
    const dbPort = str('DB_PORT', '2480');
    // Relative to the working directory unless absolute, scoped by DB_NAME (as before).
    const dataDir = str('DATA_DIR', 'data/' + dbName);
    const maxVersion = num('MAX_VERSION_TEXT_BYTES', 10 * 1024 * 1024);
    return {
        port: num('PORT', 8200),
        development: process.env.MODE === 'development',
        devUser: str('DEV_USER', 'local.user@localhost'),
        logLevel: str('LOG_LEVEL', 'info'),
        apiUrl: str('API_URL', 'http://localhost:8200/'),
        dataDir,
        dbName,
        db: {
            url: `${dbHost}:${dbPort}/api/v1/command/${dbName}`,
            user: str('DB_USER', 'root'),
            password: process.env.DB_PASSWORD,
            legacy: bool('LEGACY_ARCADEDB', true),
            writeRetries: Math.max(1, num('DB_WRITE_RETRIES', 5)),
            backoffBaseMs: num('DB_WRITE_BACKOFF_BASE_MS', 200),
            backoffMaxMs: num('DB_WRITE_BACKOFF_MAX_MS', 5000),
        },
        solr: { url: str('SOLR_URL', 'http://localhost:8983/solr'), core: str('SOLR_CORE', 'messydesk') },
        nomad: { enabled: bool('NOMAD', false), url: str('NOMAD_URL', 'http://localhost:4646/v1'), podman: Boolean(process.env.PODMAN) },
        // The old backend read DISK_QUOTA (documented as DISK_QUOTA_GB); both are accepted.
        diskQuotaGb: num('DISK_QUOTA', num('DISK_QUOTA_GB', 100)) || 100,
        projectExpirationDays: num('PROJECT_EXPIRATION_DAYS', 180) || 180,
        serviceToken: str('SERVICE_TOKEN', ''),
        serviceAuthLegacyMail: bool('SERVICE_AUTH_LEGACY_MAIL', true),
        serviceRegistryPath: str('SERVICE_REGISTRY_PATH', path.join(dataDir, 'service-registry.json')),
        consumerTtlSeconds: num('CONSUMER_TTL_SECONDS', 90),
        queue: {
            dbPath: str('QUEUE_DB_PATH', path.join(dataDir, 'queue.sqlite')),
            maxAttempts: num('QUEUE_DB_MAX_ATTEMPTS', 3),
            leaseSeconds: num('QUEUE_DB_LEASE_SECONDS', 120),
            keepFailedMinutes: num('QUEUE_DB_KEEP_FAILED_MINUTES', 1440),
            sweeperEnabled: bool('QUEUE_DB_SWEEPER_ENABLED', true),
            sweeperIntervalSeconds: num('QUEUE_DB_SWEEPER_INTERVAL_SECONDS', 300),
            sweeperDoneCancelledMinutes: num('QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES', 60),
            batchAbortConsecutive: num('QUEUE_BATCH_ABORT_CONSECUTIVE', 5),
            batchAbortPercent: num('QUEUE_BATCH_ABORT_PERCENT', 50),
            logContext: bool('LOG_QUEUE_CONTEXT', false),
        },
        setZipJobTtlMs: num('SET_ZIP_JOB_TTL_MS', 30 * 60 * 1000),
        maxVersionTextBytes: maxVersion > 0 ? maxVersion : 10 * 1024 * 1024,
        help: {
            bundleMaxFiles: num('SERVICE_HELP_BUNDLE_MAX_FILES', 120),
            archiveMaxBytes: num('SERVICE_HELP_ARCHIVE_MAX_BYTES', 25 * 1024 * 1024),
            archiveMaxEntries: num('SERVICE_HELP_ARCHIVE_MAX_ENTRIES', 500),
        },
        publicDir: path.resolve(root, 'public'),
        helpDir: path.resolve(root, 'public/help'),
        filtersDir: path.resolve(root, 'filters'),
    };
}
