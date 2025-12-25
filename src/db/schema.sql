-- Flight Tracker Database Schema

-- Flights to track
CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                    -- "Mom's Spain Trip"
    origin TEXT NOT NULL,                  -- "ATL"
    destination TEXT NOT NULL,             -- "MAD"
    departure_date TEXT NOT NULL,          -- "2025-09-15"
    return_date TEXT,                      -- "2025-09-25" (optional for one-way)
    passengers INTEGER DEFAULT 1,
    cabin_class TEXT DEFAULT 'economy',    -- economy, premium_economy, business, first
    preferred_airline TEXT DEFAULT 'any',  -- 'any', 'Delta', 'United', etc (used by scraper)
    is_active INTEGER DEFAULT 1,
    notify_email TEXT,                     -- Email for price alerts
    price_threshold REAL,                  -- Alert if price drops below this
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Price history
CREATE TABLE IF NOT EXISTS prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    price REAL NOT NULL,
    currency TEXT DEFAULT 'USD',
    airline TEXT,                          -- "Delta", "United", etc.
    stops INTEGER,                         -- 0 = direct, 1 = 1 stop, etc.
    duration_minutes INTEGER,
    departure_time TEXT,                   -- "08:30"
    arrival_time TEXT,                     -- "22:45"
    source TEXT DEFAULT 'google_flights',
    raw_data TEXT,                         -- JSON blob of full result
    checked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (flight_id) REFERENCES flights(id)
);

-- Notifications sent
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    price_id INTEGER NOT NULL,
    type TEXT NOT NULL,                    -- 'price_drop', 'price_spike', 'best_time_to_buy'
    message TEXT,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (flight_id) REFERENCES flights(id),
    FOREIGN KEY (price_id) REFERENCES prices(id)
);

-- Indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_prices_flight_id ON prices(flight_id);
CREATE INDEX IF NOT EXISTS idx_prices_checked_at ON prices(checked_at);
CREATE INDEX IF NOT EXISTS idx_flights_active ON flights(is_active);
