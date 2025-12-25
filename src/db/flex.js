import { getDb } from './setup.js';

export function upsertFlexPrice({
    flight_id,
    departure_date,
    return_date,
    cabin_class,
    passengers,
    price,
    currency = 'USD',
    airline = null,
    source = 'amadeus'
}) {
    const db = getDb();
    db.prepare(`
        INSERT INTO flex_prices (
            flight_id,
            departure_date,
            return_date,
            cabin_class,
            passengers,
            price,
            currency,
            airline,
            source,
            checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(flight_id, departure_date, return_date, cabin_class, passengers)
        DO UPDATE SET
            price = excluded.price,
            currency = excluded.currency,
            airline = excluded.airline,
            source = excluded.source,
            checked_at = CURRENT_TIMESTAMP
    `).run(
        flight_id,
        departure_date,
        return_date || '',
        cabin_class,
        passengers,
        price,
        currency,
        airline,
        source
    );
    db.close();
}

export function getFlexPrices({ flight_id, window = 5, maxAgeHours = 6, cabin_class = null, passengers = null }) {
    const db = getDb();
    const where = ['flight_id = ?', `checked_at >= datetime('now', '-' || ? || ' hours')`];
    const params = [flight_id, maxAgeHours];

    if (cabin_class) {
        where.push('cabin_class = ?');
        params.push(cabin_class);
    }

    if (passengers) {
        where.push('passengers = ?');
        params.push(passengers);
    }

    const rows = db.prepare(`
        SELECT * FROM flex_prices
        WHERE ${where.join(' AND ')}
        ORDER BY departure_date ASC
    `).all(...params);
    db.close();

    const expected = window * 2 + 1;
    return { rows, isComplete: rows.length >= expected };
}

export function getBestFlexPrice({ flight_id, maxAgeHours = 12, cabin_class = null, passengers = null }) {
    const db = getDb();
    const where = ['flight_id = ?', `checked_at >= datetime('now', '-' || ? || ' hours')`, 'price IS NOT NULL'];
    const params = [flight_id, maxAgeHours];

    if (cabin_class) {
        where.push('cabin_class = ?');
        params.push(cabin_class);
    }

    if (passengers) {
        where.push('passengers = ?');
        params.push(passengers);
    }

    const row = db.prepare(`
        SELECT * FROM flex_prices
        WHERE ${where.join(' AND ')}
        ORDER BY price ASC
        LIMIT 1
    `).get(...params);
    db.close();
    return row;
}
