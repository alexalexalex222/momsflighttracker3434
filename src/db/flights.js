import { getDb } from './setup.js';

// Get all active flights to track
export function getActiveFlights() {
    const db = getDb();
    const flights = db.prepare(`
        SELECT * FROM flights WHERE is_active = 1
    `).all();
    db.close();
    return flights;
}

// Add a new flight to track
export function addFlight({
    name,
    origin,
    destination,
    departure_date,
    return_date,
    passengers,
    cabin_class,
    preferred_airline,
    notify_email,
    price_threshold
}) {
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO flights (
            name,
            origin,
            destination,
            departure_date,
            return_date,
            passengers,
            cabin_class,
            preferred_airline,
            notify_email,
            price_threshold
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        name,
        origin,
        destination,
        departure_date,
        return_date || null,
        passengers || 1,
        cabin_class || 'economy',
        preferred_airline || 'any',
        notify_email || null,
        price_threshold || null
    );
    db.close();
    return result.lastInsertRowid;
}

export function getFlight(flightId) {
    const db = getDb();
    const flight = db.prepare(`SELECT * FROM flights WHERE id = ?`).get(flightId);
    db.close();
    return flight;
}

export function updateFlight(flightId, patch) {
    const allowed = new Map([
        ['name', 'name'],
        ['origin', 'origin'],
        ['destination', 'destination'],
        ['departure_date', 'departure_date'],
        ['return_date', 'return_date'],
        ['passengers', 'passengers'],
        ['cabin_class', 'cabin_class'],
        ['preferred_airline', 'preferred_airline'],
        ['notify_email', 'notify_email'],
        ['price_threshold', 'price_threshold'],
        ['is_active', 'is_active']
    ]);

    const keys = Object.keys(patch || {}).filter(k => allowed.has(k));
    if (!keys.length) return null;

    const assignments = keys.map(k => `${allowed.get(k)} = ?`).join(', ');
    const values = keys.map(k => patch[k]);

    const db = getDb();
    const stmt = db.prepare(`
        UPDATE flights
        SET ${assignments}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `);
    stmt.run(...values, flightId);
    const updated = db.prepare(`SELECT * FROM flights WHERE id = ?`).get(flightId);
    db.close();
    return updated;
}

export function updateFlightCheckStatus(flightId, status, errorText = null) {
    const db = getDb();
    db.prepare(`
        UPDATE flights
        SET last_checked_at = CURRENT_TIMESTAMP,
            last_check_status = ?,
            last_check_error = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(status, errorText, flightId);
    db.close();
}

// Get a specific flight with its price history
export function getFlightWithPrices(flightId) {
    const db = getDb();
    const flight = db.prepare(`SELECT * FROM flights WHERE id = ?`).get(flightId);
    if (!flight) {
        db.close();
        return null;
    }
    const prices = db.prepare(`
        SELECT * FROM prices WHERE flight_id = ? ORDER BY checked_at DESC
    `).all(flightId);
    db.close();
    return { ...flight, prices };
}

// Save a new price record
export function savePrice({ flight_id, price, currency, airline, stops, duration_minutes, departure_time, arrival_time, raw_data, source }) {
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO prices (flight_id, price, currency, airline, stops, duration_minutes, departure_time, arrival_time, raw_data, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        flight_id,
        price,
        currency || 'USD',
        airline || null,
        stops ?? null,
        duration_minutes || null,
        departure_time || null,
        arrival_time || null,
        raw_data ? JSON.stringify(raw_data) : null,
        source || 'google_flights'
    );
    db.close();
    return result.lastInsertRowid;
}

// Get latest price for a flight
export function getLatestPrice(flightId) {
    const db = getDb();
    const price = db.prepare(`
        SELECT * FROM prices WHERE flight_id = ? ORDER BY checked_at DESC LIMIT 1
    `).get(flightId);
    db.close();
    return price;
}

// Get lowest price ever for a flight
export function getLowestPrice(flightId) {
    const db = getDb();
    const price = db.prepare(`
        SELECT * FROM prices WHERE flight_id = ? ORDER BY price ASC LIMIT 1
    `).get(flightId);
    db.close();
    return price;
}

// Get price history for analysis (last N days)
export function getPriceHistory(flightId, days = 30) {
    const db = getDb();
    const prices = db.prepare(`
        SELECT * FROM prices
        WHERE flight_id = ?
        AND checked_at >= datetime('now', '-' || ? || ' days')
        ORDER BY checked_at ASC
    `).all(flightId, days);
    db.close();
    return prices;
}

// Deactivate a flight
export function deactivateFlight(flightId) {
    const db = getDb();
    db.prepare(`UPDATE flights SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(flightId);
    db.close();
}

// Get all flights with their latest prices
export function getAllFlightsWithLatestPrice() {
    const db = getDb();
    const flights = db.prepare(`
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
    `).all();
    db.close();
    return flights;
}
