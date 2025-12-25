import { getDb } from './setup.js';

export function createJob({ type, flight_id = null, progress_total = 0 }) {
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO jobs (type, flight_id, status, progress_current, progress_total)
        VALUES (?, ?, 'queued', 0, ?)
    `).run(type, flight_id, progress_total || 0);
    db.close();
    return result.lastInsertRowid;
}

export function updateJob(jobId, fields = {}) {
    const allowed = new Map([
        ['status', 'status'],
        ['progress_current', 'progress_current'],
        ['progress_total', 'progress_total'],
        ['result_json', 'result_json'],
        ['error_text', 'error_text'],
        ['started_at', 'started_at'],
        ['finished_at', 'finished_at']
    ]);

    const keys = Object.keys(fields).filter(k => allowed.has(k));
    if (!keys.length) return;

    const assignments = keys.map(k => `${allowed.get(k)} = ?`).join(', ');
    const values = keys.map(k => fields[k]);

    const db = getDb();
    db.prepare(`UPDATE jobs SET ${assignments} WHERE id = ?`).run(...values, jobId);
    db.close();
}

export function getJob(jobId) {
    const db = getDb();
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    db.close();
    return job;
}
