import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // BetsAPI (Soccer API)
  betsapi: {
    token: process.env.BETSAPI_TOKEN || '',
    baseUrl: process.env.BETSAPI_BASE_URL || 'https://api.b365api.com',
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },

  // Database
  database: {
    path: process.env.DATABASE_PATH || './data/betting.db',
  },

  // Target Leagues
  targetLeagues: (process.env.TARGET_LEAGUES || '23114,37298,38439,22614')
    .split(',')
    .map((id) => parseInt(id.trim(), 10)),

  // League Names Mapping (BetsAPI League IDs)
  leagueNames: {
    23114: 'GT League',
    37298: 'H2H GG League',
    38439: 'Battle Volta',
    22614: 'Battle 8min',
  } as Record<number, string>,

  // Target Goal Lines per League (the goal line we want to detect)
  targetGoalLines: {
    23114: 2.5,   // GT League - 2.5 line
    37298: 1.5,   // H2H GG League - 1.5 line
    38439: 3.5,   // Battle Volta - 3.5 line
    22614: 3.5,   // Battle 8min - 3.5 line
  } as Record<number, number>,

  // Bet365 League Name Patterns (for raw inplay data filtering)
  // These patterns match the league names in bet365 raw data
  bet365LeaguePatterns: [
    { pattern: /esoccer.*gt.*league/i, leagueId: 23114, name: 'GT League' },
    { pattern: /esoccer.*h2h.*gg.*league/i, leagueId: 37298, name: 'H2H GG League' },
    { pattern: /esoccer.*battle.*volta/i, leagueId: 38439, name: 'Battle Volta' },
    { pattern: /esoccer.*battle.*8.*min/i, leagueId: 22614, name: 'Battle 8min' },
  ],

  // Polling
  pollingInterval: parseInt(process.env.POLLING_INTERVAL || '30000', 10),

  // Database limits - rolling database to keep only recent matches
  maxMatches: parseInt(process.env.MAX_MATCHES || '3200', 10),

  // Detection
  detection: {
    marketType: 'Asian Goal Line',
  },

  // Helper function to get target goal line for a league
  getTargetGoalLine(leagueId: number): number {
    return this.targetGoalLines[leagueId] ?? 1.5; // Default to 1.5 if not configured
  },
};

export default config;
