import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '../../data/flights.db');

export function getDb() {
    return new Database(DB_PATH);
}

export function setupDatabase() {
    const db = getDb();
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);
    console.log('Database setup complete:', DB_PATH);
    db.close();
}

// Run setup if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    setupDatabase();
}
