// Script to clear match data but keep users
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'betting.db');
const db = new Database(dbPath);

try {
  // Delete odds_history first (foreign key constraint)
  const oddsResult = db.prepare('DELETE FROM odds_history').run();
  console.log(`Deleted ${oddsResult.changes} records from odds_history`);

  // Delete matches
  const matchesResult = db.prepare('DELETE FROM matches').run();
  console.log(`Deleted ${matchesResult.changes} records from matches`);

  // Show remaining users
  const users = db.prepare('SELECT COUNT(*) as count FROM users').get();
  console.log(`Users table intact: ${users.count} user(s) remain`);

  console.log('\nDatabase cleared successfully! Users preserved.');
} catch (error) {
  console.error('Error:', error.message);
} finally {
  db.close();
}
