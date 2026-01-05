// Match entity
export interface Match {
  id?: number;
  match_id: string;
  bet365_id?: string;
  league_id: number;
  home_team: string;
  away_team: string;
  detection_time: string;
  detected_odds?: number;       // Initial/first detected goal line (stays at 1.5 if match touched 1.5)
  current_goal_line?: number;   // Current/latest goal line value
  current_score?: string;
  status: 'live' | 'finished';
  final_score_home?: number;
  final_score_away?: number;
  match_end_time?: string;
  alert_sent?: number;
  result_alert_sent?: number;
  touched_15?: number;  // 1 if match ever reached goal line 1.5, 0 otherwise
  created_at?: string;
  updated_at?: string;
}

// Odds history entity
export interface OddsHistory {
  id?: number;
  match_id: string;
  odds_value?: number;
  handicap?: number;
  add_time?: string;
  recorded_at?: string;
}

// API log entity
export interface ApiLog {
  id?: number;
  endpoint: string;
  response_status?: number;
  response_time_ms?: number;
  error_message?: string;
  created_at?: string;
}

// BetsAPI Response Types
export interface BetsAPIResponse<T> {
  success: number;
  results?: T[];
  pager?: {
    page: number;
    per_page: number;
    total: number;
  };
}

export interface BetsAPIMatch {
  id: string;
  sport_id: string;
  time: string;
  time_status: string;
  league: {
    id: string;
    name: string;
    cc?: string; // Country code
  };
  home: {
    id: string;
    name: string;
    image_id?: string;
    cc?: string;
  };
  away: {
    id: string;
    name: string;
    image_id?: string;
    cc?: string;
  };
  ss?: string; // Score string "0-0"
  bet365_id?: string; // Bet365 fixture ID
  timer?: {
    tm: number;
    ts: number;
    tt: string;
    ta?: number;
    md?: number;
  };
  scores?: Record<string, { home: string; away: string }>;
  stats?: Record<string, any>;
  extra?: Record<string, any>;
  odds?: Record<string, any>;
}

export interface BetsAPIOdds {
  id: string;
  home_od?: string;
  away_od?: string;
  handicap?: string;
  add_time?: string;
  ss?: string;
}

export interface BetsAPIOddsSummary {
  bet365?: {
    asian_lines?: {
      sp?: {
        asian_handicap?: BetsAPIOdds[];
        goal_line?: BetsAPIOdds[];
      };
    };
    main?: {
      sp?: {
        asian_handicap?: BetsAPIOdds[];
        goal_line?: BetsAPIOdds[];
      };
    };
    goals?: {
      sp?: {
        asian_handicap?: BetsAPIOdds[];
        goal_line?: BetsAPIOdds[];
      };
    };
  };
}

export interface BetsAPIResult {
  id: string;
  sport_id: string;
  time: string;
  time_status: string;
  league: {
    id: string;
    name: string;
  };
  home: {
    id: string;
    name: string;
  };
  away: {
    id: string;
    name: string;
  };
  ss?: string;
  scores?: Record<string, { home: string; away: string }>;
}

// Raw Bet365 Inplay Data Types (compatible with both old and new API formats)
export interface Bet365RawItem {
  type: string; // "CT" for category/tournament, "EV" for event
  CT?: string;  // Category/tournament name for events
  ID?: string;  // Event ID
  NA?: string;  // Name (match name for events, league name for CT)
  L3?: string;  // League code
  SS?: string;  // Score string "0-0"
  TU?: string;  // Time unit/minute
  TS?: string;  // Time seconds
  TT?: string;  // Time type (e.g., "1" for first half)
  IT?: string;  // In tournament flag
  FI?: string;  // Fixture ID (bet365_id)
  C1?: string;  // Category 1
  C2?: string;  // Category 2
  C3?: string;  // Category 3
  league_id?: string; // League ID from Soccer API
  home?: { id: string; name: string; image_id?: string }; // Home team from Soccer API
  away?: { id: string; name: string; image_id?: string }; // Away team from Soccer API
  [key: string]: any; // Other fields that may be present
}

export interface Bet365RawInplayResponse {
  success: number;
  results?: Bet365RawItem[];
}

// Parsed match from raw bet365 data
export interface Bet365ParsedMatch {
  id: string;
  bet365Id: string;
  leagueName: string;
  leagueId: number;
  homeTeam: string;
  awayTeam: string;
  score?: string;
  minute?: string;
}

// Telegram message types
export interface TelegramAlert {
  type: 'detection' | 'result';
  match: Match;
  oddsHistory?: OddsHistory[];
}
