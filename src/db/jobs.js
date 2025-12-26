import { getDb } from './setup.js';

export function createJob({ type, flight_id = null, progress_total = 0, payload_json = null }) {
    const db = getDb();
    const result = db.prepare(`
        INSERT INTO jobs (type, flight_id, status, progress_current, progress_total, payload_json)
        VALUES (?, ?, 'queued', 0, ?, ?)
    `).run(type, flight_id, progress_total || 0, payload_json);
    db.close();
    return result.lastInsertRowid;
}

export function updateJob(jobId, fields = {}) {
    const allowed = new Map([
        ['status', 'status'],
        ['progress_current', 'progress_current'],
        ['progress_total', 'progress_total'],
        ['payload_json', 'payload_json'],
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

export function claimNextJob() {
    const db = getDb();
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
        const job = db.prepare(`
            SELECT * FROM jobs
            WHERE status = 'queued'
            ORDER BY created_at ASC
            LIMIT 1
        `).get();

        if (!job) return null;

        db.prepare(`
            UPDATE jobs
            SET status = 'running',
                started_at = ?
            WHERE id = ?
        `).run(now, job.id);

        return { ...job, status: 'running', started_at: now };
    });

    const claimed = tx();
    db.close();
    return claimed;
}
