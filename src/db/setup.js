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
    if (!flightCols.includes('last_checked_at')) {
        db.exec(`ALTER TABLE flights ADD COLUMN last_checked_at TEXT`);
    }
    if (!flightCols.includes('last_check_status')) {
        db.exec(`ALTER TABLE flights ADD COLUMN last_check_status TEXT`);
    }
    if (!flightCols.includes('last_check_error')) {
        db.exec(`ALTER TABLE flights ADD COLUMN last_check_error TEXT`);
    }

    const jobCols = db.prepare(`PRAGMA table_info(jobs)`).all().map(c => c.name);
    if (jobCols.length && !jobCols.includes('payload_json')) {
        db.exec(`ALTER TABLE jobs ADD COLUMN payload_json TEXT`);
    }

    // New tables (safe to run repeatedly)
    db.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            flight_id INTEGER,
            status TEXT NOT NULL DEFAULT 'queued',
            progress_current INTEGER DEFAULT 0,
            progress_total INTEGER DEFAULT 0,
            payload_json TEXT,
            result_json TEXT,
            error_text TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            started_at TEXT,
            finished_at TEXT,
            FOREIGN KEY (flight_id) REFERENCES flights(id)
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_flight_id ON jobs(flight_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

        CREATE TABLE IF NOT EXISTS flex_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flight_id INTEGER NOT NULL,
            departure_date TEXT NOT NULL,
            return_date TEXT DEFAULT '',
            cabin_class TEXT NOT NULL,
            passengers INTEGER NOT NULL,
            price REAL,
            currency TEXT DEFAULT 'USD',
            airline TEXT,
            source TEXT DEFAULT 'amadeus',
            checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(flight_id, departure_date, return_date, cabin_class, passengers),
            FOREIGN KEY (flight_id) REFERENCES flights(id)
        );

        CREATE INDEX IF NOT EXISTS idx_flex_flight_id ON flex_prices(flight_id);
        CREATE INDEX IF NOT EXISTS idx_flex_checked_at ON flex_prices(checked_at);

        CREATE TABLE IF NOT EXISTS contexts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            flight_id INTEGER NOT NULL,
            context_json TEXT NOT NULL,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT,
            FOREIGN KEY (flight_id) REFERENCES flights(id)
        );

        CREATE INDEX IF NOT EXISTS idx_contexts_flight_id ON contexts(flight_id);
        CREATE INDEX IF NOT EXISTS idx_contexts_expires_at ON contexts(expires_at);
    `);
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
