import { getDb } from './setup.js';

export function upsertContext({ flight_id, context_json, expires_at }) {
    const db = getDb();
    db.prepare(`
        INSERT INTO contexts (flight_id, context_json, fetched_at, expires_at)
        VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    `).run(flight_id, context_json, expires_at || null);
    db.close();
}

export function getContext({ flight_id, maxAgeHours = 6 }) {
    const db = getDb();
    const row = db.prepare(`
        SELECT * FROM contexts
        WHERE flight_id = ?
          AND fetched_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY fetched_at DESC
        LIMIT 1
    `).get(flight_id, maxAgeHours);
    db.close();
    return row;
}
