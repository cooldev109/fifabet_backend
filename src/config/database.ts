import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './index';

// Ensure data directory exists
const dbDir = path.dirname(config.database.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database connection
const db: DatabaseType = new Database(config.database.path);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Initialize schema
export function initializeDatabase(): void {
  // Create matches table
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT UNIQUE NOT NULL,
      bet365_id TEXT,
      league_id INTEGER NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      detection_time TEXT NOT NULL,
      detected_odds REAL,
      current_score TEXT,
      status TEXT DEFAULT 'live' CHECK(status IN ('live', 'finished')),
      final_score_home INTEGER,
      final_score_away INTEGER,
      match_end_time TEXT,
      alert_sent INTEGER DEFAULT 0,
      result_alert_sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Add current_score column if it doesn't exist (migration for existing databases)
  try {
    db.exec(`ALTER TABLE matches ADD COLUMN current_score TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Add touched_15 column - marks if match ever reached goal line 1.5
  try {
    db.exec(`ALTER TABLE matches ADD COLUMN touched_15 INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Add current_goal_line column - tracks the latest/final goal line value
  try {
    db.exec(`ALTER TABLE matches ADD COLUMN current_goal_line REAL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migrate existing data: set touched_15 = 1 for matches that already have alert_sent = 1
  try {
    db.exec(`UPDATE matches SET touched_15 = 1 WHERE alert_sent = 1 AND touched_15 IS NULL`);
    db.exec(`UPDATE matches SET touched_15 = 0 WHERE touched_15 IS NULL`);
  } catch (e) {
    // Migration may fail if column doesn't exist yet
  }

  // Migrate existing data: copy detected_odds to current_goal_line where not set
  try {
    db.exec(`UPDATE matches SET current_goal_line = detected_odds WHERE current_goal_line IS NULL`);
  } catch (e) {
    // Migration may fail if column doesn't exist yet
  }

  // Create odds_history table
  db.exec(`
    CREATE TABLE IF NOT EXISTS odds_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      odds_value REAL,
      handicap REAL,
      add_time TEXT,
      recorded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (match_id) REFERENCES matches(match_id),
      UNIQUE(match_id, handicap, odds_value)
    )
  `);

  // Create api_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      response_status INTEGER,
      response_time_ms INTEGER,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_matches_match_id ON matches(match_id);
    CREATE INDEX IF NOT EXISTS idx_matches_league_id ON matches(league_id);
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_matches_detection_time ON matches(detection_time);
    CREATE INDEX IF NOT EXISTS idx_odds_history_match_id ON odds_history(match_id);
    CREATE INDEX IF NOT EXISTS idx_odds_history_recorded_at ON odds_history(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_api_logs_endpoint ON api_logs(endpoint);
    CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at);
  `);

  // Create unique index for odds_history if not exists (for existing tables)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_odds_history_unique ON odds_history(match_id, handicap, odds_value)`);
  } catch (e) {
    // Index may already exist or conflict, ignore
  }

  console.log('Database initialized successfully');
}

export default db;
