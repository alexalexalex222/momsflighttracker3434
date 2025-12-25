import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENV_DB_PATH_KEYS = ['DB_PATH', 'FLIGHT_TRACKER_DB_PATH', 'SQLITE_PATH'];

function getEnvDbPath() {
    for (const key of ENV_DB_PATH_KEYS) {
        const value = process.env[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function getDefaultDbPath() {
    // Keep a stable location relative to the repo for local development.
    return join(__dirname, '../../data/flights.db');
}

function getFallbackDbPath() {
    // Always writable in serverless/container environments (but ephemeral).
    return join(tmpdir(), 'flights.db');
}

let resolvedDbPath =
    getEnvDbPath() ||
    (process.env.VERCEL ? getFallbackDbPath() : getDefaultDbPath());

let didInit = false;
let didLogPath = false;

export function getDbPath() {
    return resolvedDbPath;
}

function ensureDirectoryExists(filePath) {
    if (filePath === ':memory:') return;
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
}

function migrate(db) {
    // Lightweight migrations for columns added after initial schema.sql
    // (CREATE TABLE IF NOT EXISTS won't add columns to existing tables).
    const flightCols = db.prepare(`PRAGMA table_info(flights)`).all().map(c => c.name);
    if (!flightCols.includes('preferred_airline')) {
        db.exec(`ALTER TABLE flights ADD COLUMN preferred_airline TEXT DEFAULT 'any'`);
    }
}

function initializeIfNeeded(db) {
    if (didInit) return;

    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);
    migrate(db);
    didInit = true;

    if (!didLogPath) {
        didLogPath = true;
        console.log(`[DB] Ready: ${resolvedDbPath}`);
    }
}

export function getDb() {
    const envDbPath = getEnvDbPath();
    if (envDbPath && envDbPath !== resolvedDbPath) {
        resolvedDbPath = envDbPath;
        didInit = false;
        didLogPath = false;
    }

    try {
        ensureDirectoryExists(resolvedDbPath);
        const db = new Database(resolvedDbPath);
        initializeIfNeeded(db);
        return db;
    } catch (error) {
        // If no explicit DB path is configured, fall back to /tmp so Railway/Vercel can write.
        if (envDbPath) {
            throw error;
        }

        const fallbackPath = getFallbackDbPath();
        if (resolvedDbPath !== fallbackPath) {
            console.warn(
                `[DB] Could not open ${resolvedDbPath} (${error.message}). ` +
                `Falling back to ${fallbackPath}. Set DB_PATH to override.`
            );
        }

        resolvedDbPath = fallbackPath;
        didInit = false;
        didLogPath = false;

        ensureDirectoryExists(resolvedDbPath);
        const db = new Database(resolvedDbPath);
        initializeIfNeeded(db);
        return db;
    }
}

export function setupDatabase() {
    const db = getDb();
    // getDb() already runs schema + migrations on first open; re-run for safety.
    try {
        const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
        db.exec(schema);
        migrate(db);
    } finally {
        db.close();
    }

    console.log('Database setup complete:', resolvedDbPath);
}

// Run setup if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    setupDatabase();
}
