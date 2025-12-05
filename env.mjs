const DB_HOST = process.env.DB_HOST || 'http://127.0.0.1';
const DB_PORT = process.env.DB_PORT || 2480;
export const DB_NAME = process.env.DB_NAME || 'messydesk';

export const DB_URL = `${DB_HOST}:${DB_PORT}/api/v1/command/${DB_NAME}`
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASSWORD = process.env.DB_PASSWORD;

export const API_URL = process.env.API_URL || 'http://localhost:8200/';
export const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
export const NATS_URL_STATUS = process.env.NATS_URL_STATUS || 'http://localhost:8222';
export const DATA_DIR = 'data/' + DB_NAME;
export const SOLR_URL = process.env.SOLR_URL || 'http://localhost:8983/solr';
export const SOLR_CORE = process.env.SOLR_CORE || 'messydesk';


