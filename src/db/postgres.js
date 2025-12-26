/**
 * PostgreSQL Database Layer
 *
 * Production-grade persistence for the Flight Tracker.
 * Uses PostgreSQL when DATABASE_URL is set (Railway provides this).
 */

import pg from 'pg';
const { Pool } = pg;

let pool = null;

export function getPool() {
    if (!pool) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL environment variable is required for PostgreSQL');
        }

        pool = new Pool({
            connectionString,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        pool.on('error', (err) => {
            console.error('[DB] Unexpected error on idle client', err);
        });
    }
    return pool;
}

export async function query(text, params) {
    const pool = getPool();
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        if (duration > 100) {
            console.log('[DB] Slow query:', { text: text.substring(0, 100), duration, rows: res.rowCount });
        }
        return res;
    } catch (error) {
        console.error('[DB] Query error:', { text: text.substring(0, 100), error: error.message });
        throw error;
    }
}

export async function getOne(text, params) {
    const res = await query(text, params);
    return res.rows[0] || null;
}

export async function getAll(text, params) {
    const res = await query(text, params);
    return res.rows;
}

// Initialize database schema
export async function initializeDatabase() {
    console.log('[DB] Initializing PostgreSQL database...');

    // Create tables
    await query(`
        CREATE TABLE IF NOT EXISTS flights (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            origin TEXT NOT NULL,
            destination TEXT NOT NULL,
            departure_date TEXT NOT NULL,
            return_date TEXT,
            passengers INTEGER DEFAULT 1,
            cabin_class TEXT DEFAULT 'economy',
            preferred_airline TEXT DEFAULT 'any',
            is_active INTEGER DEFAULT 1,
            notify_email TEXT,
            price_threshold REAL,
            last_checked_at TIMESTAMPTZ,
            last_check_status TEXT,
            last_check_error TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS prices (
            id SERIAL PRIMARY KEY,
            flight_id INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            price REAL NOT NULL,
            currency TEXT DEFAULT 'USD',
            airline TEXT,
            stops INTEGER,
            duration_minutes INTEGER,
            departure_time TEXT,
            arrival_time TEXT,
            source TEXT DEFAULT 'google_flights',
            raw_data TEXT,
            checked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS notifications (
            id SERIAL PRIMARY KEY,
            flight_id INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            price_id INTEGER NOT NULL REFERENCES prices(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            message TEXT,
            sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS jobs (
            id SERIAL PRIMARY KEY,
            type TEXT NOT NULL,
            flight_id INTEGER REFERENCES flights(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'queued',
            progress_current INTEGER DEFAULT 0,
            progress_total INTEGER DEFAULT 0,
            payload_json TEXT,
            result_json TEXT,
            error_text TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS flex_prices (
            id SERIAL PRIMARY KEY,
            flight_id INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            departure_date TEXT NOT NULL,
            return_date TEXT DEFAULT '',
            cabin_class TEXT NOT NULL,
            passengers INTEGER NOT NULL,
            price REAL,
            currency TEXT DEFAULT 'USD',
            airline TEXT,
            source TEXT DEFAULT 'amadeus',
            checked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(flight_id, departure_date, return_date, cabin_class, passengers)
        )
    `);

    await query(`
        CREATE TABLE IF NOT EXISTS contexts (
            id SERIAL PRIMARY KEY,
            flight_id INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
            context_json TEXT NOT NULL,
            fetched_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMPTZ
        )
    `);

    // Create indexes (IF NOT EXISTS works in PostgreSQL 9.5+)
    await query(`CREATE INDEX IF NOT EXISTS idx_prices_flight_id ON prices(flight_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_prices_checked_at ON prices(checked_at)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flights_active ON flights(is_active)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_jobs_flight_id ON jobs(flight_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flex_flight_id ON flex_prices(flight_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_flex_checked_at ON flex_prices(checked_at)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_contexts_flight_id ON contexts(flight_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_contexts_expires_at ON contexts(expires_at)`);

    console.log('[DB] PostgreSQL database initialized successfully');
}

// ==================== FLIGHTS ====================

export async function getActiveFlights() {
    return getAll('SELECT * FROM flights WHERE is_active = 1');
}

export async function addFlight({
    name, origin, destination, departure_date, return_date,
    passengers, cabin_class, preferred_airline, notify_email, price_threshold
}) {
    const res = await query(`
        INSERT INTO flights (
            name, origin, destination, departure_date, return_date,
            passengers, cabin_class, preferred_airline, notify_email, price_threshold
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
    `, [
        name, origin, destination, departure_date, return_date || null,
        passengers || 1, cabin_class || 'economy', preferred_airline || 'any',
        notify_email || null, price_threshold || null
    ]);
    return res.rows[0].id;
}

export async function getFlight(flightId) {
    return getOne('SELECT * FROM flights WHERE id = $1', [flightId]);
}

export async function updateFlight(flightId, patch) {
    const allowed = ['name', 'origin', 'destination', 'departure_date', 'return_date',
                     'passengers', 'cabin_class', 'preferred_airline', 'notify_email',
                     'price_threshold', 'is_active'];

    const keys = Object.keys(patch || {}).filter(k => allowed.includes(k));
    if (!keys.length) return null;

    const assignments = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map(k => patch[k]);

    await query(
        `UPDATE flights SET ${assignments}, updated_at = CURRENT_TIMESTAMP WHERE id = $${keys.length + 1}`,
        [...values, flightId]
    );

    return getFlight(flightId);
}

export async function updateFlightCheckStatus(flightId, status, errorText = null) {
    await query(`
        UPDATE flights
        SET last_checked_at = CURRENT_TIMESTAMP,
            last_check_status = $1,
            last_check_error = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $3
    `, [status, errorText, flightId]);
}

export async function getFlightWithPrices(flightId) {
    const flight = await getFlight(flightId);
    if (!flight) return null;

    const prices = await getAll(
        'SELECT * FROM prices WHERE flight_id = $1 ORDER BY checked_at DESC',
        [flightId]
    );

    return { ...flight, prices };
}

export async function deactivateFlight(flightId) {
    await query(
        'UPDATE flights SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [flightId]
    );
}

export async function getAllFlightsWithLatestPrice() {
    return getAll(`
        SELECT
            f.*,
            p.price as latest_price,
            p.airline as latest_airline,
            p.checked_at as last_checked,
            (SELECT MIN(price) FROM prices WHERE flight_id = f.id) as lowest_price,
            (SELECT MAX(price) FROM prices WHERE flight_id = f.id) as highest_price,
            (SELECT COUNT(*) FROM prices WHERE flight_id = f.id) as check_count
        FROM flights f
        LEFT JOIN prices p ON p.id = (
            SELECT id FROM prices WHERE flight_id = f.id ORDER BY checked_at DESC LIMIT 1
        )
        ORDER BY f.created_at DESC
    `);
}

// ==================== PRICES ====================

export async function savePrice({ flight_id, price, currency, airline, stops, duration_minutes, departure_time, arrival_time, raw_data, source }) {
    const res = await query(`
        INSERT INTO prices (flight_id, price, currency, airline, stops, duration_minutes, departure_time, arrival_time, raw_data, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
    `, [
        flight_id, price, currency || 'USD', airline || null,
        stops ?? null, duration_minutes || null, departure_time || null,
        arrival_time || null, raw_data ? JSON.stringify(raw_data) : null,
        source || 'google_flights'
    ]);
    return res.rows[0].id;
}

export async function getLatestPrice(flightId) {
    return getOne(
        'SELECT * FROM prices WHERE flight_id = $1 ORDER BY checked_at DESC LIMIT 1',
        [flightId]
    );
}

export async function getLowestPrice(flightId) {
    return getOne(
        'SELECT * FROM prices WHERE flight_id = $1 ORDER BY price ASC LIMIT 1',
        [flightId]
    );
}

export async function getPriceHistory(flightId, days = 30) {
    return getAll(`
        SELECT * FROM prices
        WHERE flight_id = $1
        AND checked_at >= CURRENT_TIMESTAMP - INTERVAL '${days} days'
        ORDER BY checked_at ASC
    `, [flightId]);
}

// ==================== JOBS ====================

export async function createJob({ type, flight_id = null, progress_total = 0, payload_json = null }) {
    const res = await query(`
        INSERT INTO jobs (type, flight_id, status, progress_current, progress_total, payload_json)
        VALUES ($1, $2, 'queued', 0, $3, $4)
        RETURNING id
    `, [type, flight_id, progress_total || 0, payload_json]);
    return res.rows[0].id;
}

export async function updateJob(jobId, fields = {}) {
    const allowed = ['status', 'progress_current', 'progress_total', 'payload_json',
                     'result_json', 'error_text', 'started_at', 'finished_at'];

    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;

    const assignments = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map(k => fields[k]);

    await query(`UPDATE jobs SET ${assignments} WHERE id = $${keys.length + 1}`, [...values, jobId]);
}

export async function getJob(jobId) {
    return getOne('SELECT * FROM jobs WHERE id = $1', [jobId]);
}

export async function claimNextJob() {
    // Use a transaction to atomically claim the job
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');

        const jobRes = await client.query(`
            SELECT * FROM jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        if (!jobRes.rows[0]) {
            await client.query('ROLLBACK');
            return null;
        }

        const job = jobRes.rows[0];
        const now = new Date().toISOString();

        await client.query(`
            UPDATE jobs
            SET status = 'running', started_at = $1
            WHERE id = $2
        `, [now, job.id]);

        await client.query('COMMIT');

        return { ...job, status: 'running', started_at: now };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function getJobsForFlight(flightId, limit = 10) {
    return getAll(
        'SELECT * FROM jobs WHERE flight_id = $1 ORDER BY created_at DESC LIMIT $2',
        [flightId, limit]
    );
}

// ==================== FLEX PRICES ====================

export async function upsertFlexPrice({ flight_id, departure_date, return_date, cabin_class, passengers, price, currency, airline, source }) {
    await query(`
        INSERT INTO flex_prices (flight_id, departure_date, return_date, cabin_class, passengers, price, currency, airline, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (flight_id, departure_date, return_date, cabin_class, passengers)
        DO UPDATE SET price = $6, currency = $7, airline = $8, source = $9, checked_at = CURRENT_TIMESTAMP
    `, [flight_id, departure_date, return_date || '', cabin_class, passengers, price, currency || 'USD', airline, source || 'amadeus']);
}

export async function getFlexPrices({ flight_id, window = 5, maxAgeHours = 6, cabin_class = null, passengers = null }) {
    let whereClause = 'flight_id = $1 AND checked_at >= NOW() - INTERVAL \'' + maxAgeHours + ' hours\'';
    const params = [flight_id];
    let paramIndex = 2;

    if (cabin_class) {
        whereClause += ` AND cabin_class = $${paramIndex}`;
        params.push(cabin_class);
        paramIndex++;
    }

    if (passengers) {
        whereClause += ` AND passengers = $${paramIndex}`;
        params.push(passengers);
        paramIndex++;
    }

    const rows = await getAll(`
        SELECT * FROM flex_prices
        WHERE ${whereClause}
        ORDER BY departure_date ASC
    `, params);

    const expected = window * 2 + 1;
    return { rows, isComplete: rows.length >= expected };
}

export async function getBestFlexPrice({ flight_id, maxAgeHours = 12, cabin_class = null, passengers = null }) {
    let whereClause = 'flight_id = $1 AND checked_at >= NOW() - INTERVAL \'' + maxAgeHours + ' hours\' AND price IS NOT NULL';
    const params = [flight_id];
    let paramIndex = 2;

    if (cabin_class) {
        whereClause += ` AND cabin_class = $${paramIndex}`;
        params.push(cabin_class);
        paramIndex++;
    }

    if (passengers) {
        whereClause += ` AND passengers = $${paramIndex}`;
        params.push(passengers);
        paramIndex++;
    }

    return getOne(`
        SELECT * FROM flex_prices
        WHERE ${whereClause}
        ORDER BY price ASC
        LIMIT 1
    `, params);
}

// ==================== CONTEXTS ====================

export async function upsertContext({ flight_id, context_json, expires_at }) {
    await query(`
        INSERT INTO contexts (flight_id, context_json, fetched_at, expires_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP, $3)
    `, [flight_id, context_json, expires_at || null]);
}

export async function getContext({ flight_id, maxAgeHours = 6 }) {
    return getOne(`
        SELECT * FROM contexts
        WHERE flight_id = $1
          AND fetched_at >= NOW() - INTERVAL '${maxAgeHours} hours'
        ORDER BY fetched_at DESC
        LIMIT 1
    `, [flight_id]);
}

export async function getLatestContext(flightId) {
    return getOne(
        'SELECT * FROM contexts WHERE flight_id = $1 ORDER BY fetched_at DESC LIMIT 1',
        [flightId]
    );
}

// ==================== CLEANUP ====================

export async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
