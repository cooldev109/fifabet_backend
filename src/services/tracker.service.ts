import db from '../config/database';
import { config } from '../config';
import { betsapiService } from './betsapi.service';
import { telegramService } from './telegram.service';
import { Match, OddsHistory, BetsAPIMatch, Bet365ParsedMatch } from '../models/types';

class TrackerService {
  private isRunning = false;
  private pollingInterval: NodeJS.Timeout | null = null;

  /**
   * Start the tracking service
   */
  start(): void {
    if (this.isRunning) {
      console.log('[Tracker] Already running');
      return;
    }

    this.isRunning = true;
    console.log('[Tracker] Starting tracking service...');
    console.log(`[Tracker] Polling interval: ${config.pollingInterval}ms`);
    console.log(`[Tracker] Target leagues: ${config.targetLeagues.join(', ')}`);

    // Initial poll
    console.log('[Tracker] Running initial poll...');
    this.poll()
      .then(() => console.log('[Tracker] Initial poll completed'))
      .catch((err) => console.error('[Tracker] Initial poll error:', err));

    // Set up interval for subsequent polls
    this.pollingInterval = setInterval(() => {
      this.poll().catch((err) => console.error('[Tracker] Poll error:', err));
    }, config.pollingInterval);

    console.log('[Tracker] Service started, interval set');
  }

  /**
   * Stop the tracking service
   */
  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.isRunning = false;
    console.log('Tracking service stopped');
  }

  /**
   * Main polling function
   */
  private async poll(): Promise<void> {
    try {
      console.log(`[Tracker] [${new Date().toISOString()}] Polling for matches...`);

      // Get all live matches from target leagues using inplay_filter API
      const liveMatches = await betsapiService.getInplayFilterMatches();
      console.log(`[Tracker] Found ${liveMatches.length} live matches in target leagues`);

      // Process each match - check Asian Goal Line
      for (const match of liveMatches) {
        await this.processMatchWithGoalLine(match);
      }

      // Check for finished matches
      await this.checkFinishedMatchesV2(liveMatches);

      // Enforce rolling database limit - delete oldest matches if over limit
      this.enforceMatchLimit();

      console.log(`[Tracker] Poll cycle completed`);
    } catch (error) {
      console.error('[Tracker] Error during polling:', error);
    }
  }

  /**
   * Process a match and check Asian Goal Line
   */
  private async processMatchWithGoalLine(match: {
    id: string;
    ourEventId: string;
    bet365Id: string;
    leagueId: number;
    leagueName: string;
    homeTeam: string;
    awayTeam: string;
    score: string;
  }): Promise<void> {
    try {
      const matchId = match.id;

      // Check if match already exists in database
      const existingMatch = this.getMatch(matchId);

      // Check Asian Goal Line using our_event_id (primary method)
      let goalLineResult = await betsapiService.checkAsianGoalLine(match.ourEventId);

      // If primary method fails, try fallback with bet365 prematch odds
      if (!goalLineResult && match.bet365Id) {
        const prematchOdds = await betsapiService.getBet365PrematchOdds(match.bet365Id);
        if (prematchOdds) {
          const prematchGoalLine = betsapiService.extractPrematchAsianGoalLine(prematchOdds);
          if (prematchGoalLine) {
            goalLineResult = {
              handicap: prematchGoalLine.handicap,
              overOdds: prematchGoalLine.overOdds,
              underOdds: prematchGoalLine.underOdds,
              score: match.score,
            };
            console.log(`[Tracker] Got goal line from prematch odds: ${prematchGoalLine.handicap}`);
          }
        }
      }

      // Get target goal line for this league
      const targetGoalLine = config.getTargetGoalLine(match.leagueId);

      if (goalLineResult) {
        const { handicap, overOdds, underOdds } = goalLineResult;

        // Check if current goal line matches the target for this league
        const isTargetGoalLine = handicap === targetGoalLine;

        if (isTargetGoalLine) {
          // Asian Goal Line matches target - this is what we're looking for!
          if (!existingMatch) {
            // New target detection - save and alert
            await this.handleTargetGoalLineDetection(match, goalLineResult, targetGoalLine);
          } else {
            // Match exists - check if we need to send alert
            if (!existingMatch.alert_sent) {
              // First time seeing target for this match - mark it and send alert
              this.markMatchAsTouchedTarget(matchId, handicap, match.score, targetGoalLine);
              await this.sendTargetDetectionAlert(existingMatch, goalLineResult, targetGoalLine);
            } else {
              // Already touched target before - update current_goal_line and score (keep detected_odds)
              this.updateMatchScoreAndGoalLine(matchId, match.score, handicap);
            }
          }
        } else {
          // Goal line is not at target
          if (!existingMatch) {
            // New match - save with current goal line
            await this.saveMatchWithGoalLine(match, handicap);
          } else if (existingMatch.touched_15) {
            // Match previously touched target - DON'T overwrite detected_odds, but update current_goal_line
            this.updateMatchScoreAndGoalLine(matchId, match.score, handicap);
          } else {
            // Match never touched target - update goal line and score normally
            this.updateMatchGoalLine(matchId, handicap, match.score);
          }
        }

        // Always save odds history for tracking goal line changes
        this.saveGoalLineHistory(matchId, handicap, overOdds, underOdds);
      } else {
        // No goal line data available - just track the match with score
        console.log(`[Tracker] No Asian Goal Line data for match ${match.id} (${match.homeTeam} vs ${match.awayTeam})`);
        if (!existingMatch) {
          await this.saveMatchWithGoalLine(match, null);
        } else {
          // Update current score even without goal line data
          this.updateMatchScore(matchId, match.score);
        }
      }
    } catch (error) {
      console.error(`[Tracker] Error processing match ${match.id}:`, error);
    }
  }

  /**
   * Handle new target goal line detection
   */
  private async handleTargetGoalLineDetection(
    match: {
      id: string;
      ourEventId: string;
      bet365Id: string;
      leagueId: number;
      leagueName: string;
      homeTeam: string;
      awayTeam: string;
      score: string;
    },
    goalLineResult: {
      handicap: number;
      overOdds: string;
      underOdds: string;
      score: string;
    },
    targetGoalLine: number
  ): Promise<void> {
    const matchId = match.id;
    const now = new Date().toISOString();

    // Insert match into database with target goal line and touched_15 = 1 (touched_target)
    const stmt = db.prepare(`
      INSERT INTO matches (match_id, bet365_id, league_id, home_team, away_team, detection_time, detected_odds, current_goal_line, current_score, status, touched_15)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 1)
    `);

    stmt.run(
      matchId,
      match.bet365Id, // Store actual bet365 fixture ID for result lookup
      match.leagueId,
      match.homeTeam,
      match.awayTeam,
      now,
      goalLineResult.handicap, // detected_odds - stays at target
      goalLineResult.handicap, // current_goal_line - will be updated as it changes
      match.score
    );

    console.log(`🎯 ALERT: Target Goal Line ${targetGoalLine} detected!`);
    console.log(`   Match: ${match.homeTeam} vs ${match.awayTeam} (${match.leagueName})`);
    console.log(`   Score: ${match.score}`);
    console.log(`   Over: ${goalLineResult.overOdds} | Under: ${goalLineResult.underOdds}`);

    // Get the saved match and send alert
    const savedMatch = this.getMatch(matchId);
    if (savedMatch) {
      await this.sendTargetDetectionAlert(savedMatch, goalLineResult, targetGoalLine);
    }
  }

  /**
   * Send target goal line detection alert
   */
  private async sendTargetDetectionAlert(
    match: Match,
    goalLineResult: {
      handicap: number;
      overOdds: string;
      underOdds: string;
      score: string;
    },
    targetGoalLine: number
  ): Promise<void> {
    const success = await telegramService.sendTargetDetectionAlert(match, goalLineResult, targetGoalLine);

    if (success) {
      // Mark both alert_sent and touched_15 (touched_target)
      const stmt = db.prepare(`
        UPDATE matches SET alert_sent = 1, touched_15 = 1, updated_at = datetime('now')
        WHERE match_id = ?
      `);
      stmt.run(match.match_id);
    }
  }

  /**
   * Mark match as touched target (for existing matches that just reached target)
   */
  private markMatchAsTouchedTarget(matchId: string, handicap: number, score: string, targetGoalLine: number): void {
    const stmt = db.prepare(`
      UPDATE matches
      SET detected_odds = ?, current_goal_line = ?, current_score = ?, touched_15 = 1, updated_at = datetime('now')
      WHERE match_id = ?
    `);
    stmt.run(handicap, handicap, score, matchId);
    console.log(`🎯 Match ${matchId} marked as touched target ${targetGoalLine}!`);
  }

  /**
   * Save a match with goal line data
   */
  private async saveMatchWithGoalLine(
    match: {
      id: string;
      ourEventId: string;
      bet365Id: string;
      leagueId: number;
      leagueName: string;
      homeTeam: string;
      awayTeam: string;
      score: string;
    },
    handicap: number | null
  ): Promise<void> {
    const matchId = match.id;
    const now = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO matches (match_id, bet365_id, league_id, home_team, away_team, detection_time, detected_odds, current_goal_line, current_score, status, touched_15)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 0)
    `);

    stmt.run(
      matchId,
      match.bet365Id, // Store actual bet365 fixture ID for result lookup
      match.leagueId,
      match.homeTeam,
      match.awayTeam,
      now,
      handicap, // detected_odds
      handicap, // current_goal_line
      match.score
    );

    console.log(`📝 Match tracked: ${match.homeTeam} vs ${match.awayTeam} (${match.leagueName}) | Goal Line: ${handicap || 'N/A'} | Score: ${match.score}`);
  }

  /**
   * Update match goal line and score (for matches that never touched 1.5)
   */
  private updateMatchGoalLine(matchId: string, handicap: number, score: string): void {
    const stmt = db.prepare(`
      UPDATE matches SET detected_odds = ?, current_goal_line = ?, current_score = ?, updated_at = datetime('now')
      WHERE match_id = ?
    `);
    stmt.run(handicap, handicap, score, matchId);
  }

  /**
   * Update match score only (when no goal line data available)
   */
  private updateMatchScore(matchId: string, score: string): void {
    const stmt = db.prepare(`
      UPDATE matches SET current_score = ?, updated_at = datetime('now')
      WHERE match_id = ?
    `);
    stmt.run(score, matchId);
  }

  /**
   * Update match score and current goal line (for matches that touched 1.5 - preserves detected_odds)
   */
  private updateMatchScoreAndGoalLine(matchId: string, score: string, goalLine: number): void {
    const stmt = db.prepare(`
      UPDATE matches SET current_score = ?, current_goal_line = ?, updated_at = datetime('now')
      WHERE match_id = ?
    `);
    stmt.run(score, goalLine, matchId);
  }

  /**
   * Save goal line history
   */
  private saveGoalLineHistory(
    matchId: string,
    handicap: number,
    overOdds: string,
    underOdds: string
  ): void {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO odds_history (match_id, handicap, odds_value, add_time)
      VALUES (?, ?, ?, datetime('now'))
    `);

    // Store over odds as the main odds value
    stmt.run(matchId, handicap, parseFloat(overOdds) || 0);
  }

  /**
   * Check for finished matches (v2 with new match format)
   */
  private async checkFinishedMatchesV2(
    currentLiveMatches: Array<{
      id: string;
      ourEventId: string;
      bet365Id: string;
      leagueId: number;
      leagueName: string;
      homeTeam: string;
      awayTeam: string;
      score: string;
    }>
  ): Promise<void> {
    const dbLiveMatches = this.getLiveMatches();
    if (dbLiveMatches.length === 0) return;

    const liveMatchIds = new Set(currentLiveMatches.map((m) => m.id));

    let finishedCount = 0;
    for (const match of dbLiveMatches) {
      if (!liveMatchIds.has(match.match_id)) {
        await this.markMatchAsFinished(match);
        finishedCount++;
      }
    }

    if (finishedCount > 0) {
      console.log(`[Tracker] Marked ${finishedCount} matches as finished`);
    }
  }

  /**
   * Mark a match as finished when it's no longer in live feed
   */
  private async markMatchAsFinished(match: Match): Promise<void> {
    const now = new Date().toISOString();

    // Parse final score from current_score
    let homeScore: number | null = null;
    let awayScore: number | null = null;
    let scoreSource = 'current_score';

    if (match.current_score) {
      const [home, away] = match.current_score.split('-').map((s) => parseInt(s.trim(), 10));
      homeScore = isNaN(home) ? null : home;
      awayScore = isNaN(away) ? null : away;
    }

    // If no current_score, try to fetch result from BetsAPI
    if (homeScore === null || awayScore === null) {
      try {
        // Try using bet365_id (which stores our_event_id) to get result
        if (match.bet365_id) {
          const result = await betsapiService.getMatchResult(match.bet365_id);
          if (result?.ss) {
            const [home, away] = result.ss.split('-').map((s) => parseInt(s.trim(), 10));
            if (!isNaN(home) && !isNaN(away)) {
              homeScore = home;
              awayScore = away;
              scoreSource = 'BetsAPI result';
            }
          }
        }
      } catch (error) {
        console.error(`[Tracker] Failed to fetch result for match ${match.match_id}:`, error);
      }
    }

    // Update match status to finished
    const stmt = db.prepare(`
      UPDATE matches
      SET status = 'finished',
          final_score_home = ?,
          final_score_away = ?,
          current_score = COALESCE(current_score, ?),
          match_end_time = ?,
          updated_at = datetime('now')
      WHERE match_id = ?
    `);

    const scoreString = (homeScore !== null && awayScore !== null) ? `${homeScore}-${awayScore}` : null;
    stmt.run(homeScore, awayScore, scoreString, now, match.match_id);

    console.log(`✅ Match finished: ${match.home_team} ${homeScore ?? '?'}-${awayScore ?? '?'} ${match.away_team} (${scoreSource})`);

    // Send result alert if not already sent
    if (!match.result_alert_sent) {
      const updatedMatch = this.getMatch(match.match_id);
      if (updatedMatch) {
        const success = await telegramService.sendResultAlert(updatedMatch);

        if (success) {
          const updateStmt = db.prepare(`
            UPDATE matches SET result_alert_sent = 1, updated_at = datetime('now')
            WHERE match_id = ?
          `);
          updateStmt.run(match.match_id);
        }
      }
    }
  }

  /**
   * Handle match finished
   */
  private async handleMatchFinished(
    match: Match,
    result: { ss?: string; [key: string]: any }
  ): Promise<void> {
    const now = new Date().toISOString();
    let homeScore: number | null = null;
    let awayScore: number | null = null;

    // Parse score
    if (result.ss) {
      const [home, away] = result.ss.split('-').map((s) => parseInt(s.trim(), 10));
      homeScore = isNaN(home) ? null : home;
      awayScore = isNaN(away) ? null : away;
    }

    // Update match in database
    const stmt = db.prepare(`
      UPDATE matches
      SET status = 'finished',
          final_score_home = ?,
          final_score_away = ?,
          match_end_time = ?,
          updated_at = datetime('now')
      WHERE match_id = ?
    `);

    stmt.run(homeScore, awayScore, now, match.match_id);

    console.log(
      `Match finished: ${match.home_team} ${homeScore}-${awayScore} ${match.away_team}`
    );

    // Send result alert if not already sent
    if (!match.result_alert_sent) {
      const updatedMatch = this.getMatch(match.match_id);
      if (updatedMatch) {
        const success = await telegramService.sendResultAlert(updatedMatch);

        if (success) {
          const updateStmt = db.prepare(`
            UPDATE matches SET result_alert_sent = 1, updated_at = datetime('now')
            WHERE match_id = ?
          `);
          updateStmt.run(match.match_id);
        }
      }
    }
  }

  /**
   * Save odds history
   */
  private saveOddsHistory(matchId: string, allOdds: any[]): void {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO odds_history (match_id, odds_value, handicap, add_time)
      VALUES (?, ?, ?, ?)
    `);

    for (const odds of allOdds) {
      stmt.run(
        matchId,
        parseFloat(odds.home_od || odds.away_od || '0'),
        parseFloat(odds.handicap || '0'),
        odds.add_time || null
      );
    }
  }

  /**
   * Get match from database
   */
  getMatch(matchId: string): Match | undefined {
    const stmt = db.prepare('SELECT * FROM matches WHERE match_id = ?');
    return stmt.get(matchId) as Match | undefined;
  }

  /**
   * Get all live matches from database
   */
  getLiveMatches(): Match[] {
    const stmt = db.prepare("SELECT * FROM matches WHERE status = 'live'");
    return stmt.all() as Match[];
  }

  /**
   * Get total count of matches with filters (for pagination)
   */
  getMatchesCount(
    options: {
      status?: 'live' | 'finished';
      leagueId?: number;
    } = {}
  ): number {
    let query = 'SELECT COUNT(*) as count FROM matches WHERE 1=1';
    const params: any[] = [];

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    if (options.leagueId) {
      query += ' AND league_id = ?';
      params.push(options.leagueId);
    }

    const stmt = db.prepare(query);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  /**
   * Get all matches from database
   */
  getAllMatches(
    options: {
      status?: 'live' | 'finished';
      leagueId?: number;
      limit?: number;
      offset?: number;
    } = {}
  ): Match[] {
    let query = 'SELECT * FROM matches WHERE 1=1';
    const params: any[] = [];

    if (options.status) {
      query += ' AND status = ?';
      params.push(options.status);
    }

    if (options.leagueId) {
      query += ' AND league_id = ?';
      params.push(options.leagueId);
    }

    query += ' ORDER BY detection_time DESC';

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    if (options.offset) {
      query += ' OFFSET ?';
      params.push(options.offset);
    }

    const stmt = db.prepare(query);
    return stmt.all(...params) as Match[];
  }

  /**
   * Get odds history for a match
   */
  getOddsHistory(matchId: string): OddsHistory[] {
    const stmt = db.prepare(
      'SELECT * FROM odds_history WHERE match_id = ? ORDER BY recorded_at ASC'
    );
    return stmt.all(matchId) as OddsHistory[];
  }

  /**
   * Get statistics including target hit ratios per league
   */
  getStats(): {
    totalMatches: number;
    liveMatches: number;
    finishedMatches: number;
    touchedTargetTotal: number;
    byLeague: Record<number, number>;
    touchedTargetByLeague: Record<number, { total: number; touched: number; ratio: number }>;
  } {
    const totalStmt = db.prepare('SELECT COUNT(*) as count FROM matches');
    const liveStmt = db.prepare("SELECT COUNT(*) as count FROM matches WHERE status = 'live'");
    const finishedStmt = db.prepare(
      "SELECT COUNT(*) as count FROM matches WHERE status = 'finished'"
    );
    const touchedTargetStmt = db.prepare(
      'SELECT COUNT(*) as count FROM matches WHERE touched_15 = 1'
    );
    const byLeagueStmt = db.prepare(
      'SELECT league_id, COUNT(*) as count FROM matches GROUP BY league_id'
    );
    const touchedByLeagueStmt = db.prepare(
      'SELECT league_id, COUNT(*) as total, SUM(CASE WHEN touched_15 = 1 THEN 1 ELSE 0 END) as touched FROM matches GROUP BY league_id'
    );

    const total = (totalStmt.get() as any).count;
    const live = (liveStmt.get() as any).count;
    const finished = (finishedStmt.get() as any).count;
    const touchedTargetTotal = (touchedTargetStmt.get() as any).count;
    const byLeagueRows = byLeagueStmt.all() as Array<{ league_id: number; count: number }>;
    const touchedByLeagueRows = touchedByLeagueStmt.all() as Array<{ league_id: number; total: number; touched: number }>;

    const byLeague: Record<number, number> = {};
    for (const row of byLeagueRows) {
      byLeague[row.league_id] = row.count;
    }

    const touchedTargetByLeague: Record<number, { total: number; touched: number; ratio: number }> = {};
    for (const row of touchedByLeagueRows) {
      touchedTargetByLeague[row.league_id] = {
        total: row.total,
        touched: row.touched || 0,
        ratio: row.total > 0 ? Math.round((row.touched || 0) / row.total * 1000) / 10 : 0, // Percentage with 1 decimal
      };
    }

    return {
      totalMatches: total,
      liveMatches: live,
      finishedMatches: finished,
      touchedTargetTotal,
      byLeague,
      touchedTargetByLeague,
    };
  }

  /**
   * Check if tracker is running
   */
  isTrackerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Enforce match limit - delete oldest finished matches to keep database at max size
   * This creates a rolling database that keeps only the most recent matches
   */
  private enforceMatchLimit(): void {
    try {
      const maxMatches = config.maxMatches;
      const totalCount = (db.prepare('SELECT COUNT(*) as count FROM matches').get() as any).count;

      if (totalCount <= maxMatches) {
        return; // No need to delete
      }

      const toDelete = totalCount - maxMatches;

      // First, get the match_ids that will be deleted
      const matchesToDelete = db.prepare(`
        SELECT match_id FROM matches
        WHERE status = 'finished'
        ORDER BY detection_time ASC
        LIMIT ?
      `).all(toDelete) as Array<{ match_id: string }>;

      if (matchesToDelete.length === 0) {
        return;
      }

      const matchIds = matchesToDelete.map(m => m.match_id);

      // Delete odds_history FIRST (before deleting matches to avoid FK constraint)
      const deleteOddsStmt = db.prepare(`
        DELETE FROM odds_history WHERE match_id = ?
      `);
      let oddsDeleted = 0;
      for (const matchId of matchIds) {
        const result = deleteOddsStmt.run(matchId);
        oddsDeleted += result.changes;
      }

      // Now delete the matches
      const deleteMatchStmt = db.prepare(`
        DELETE FROM matches WHERE match_id = ?
      `);
      let matchesDeleted = 0;
      for (const matchId of matchIds) {
        const result = deleteMatchStmt.run(matchId);
        matchesDeleted += result.changes;
      }

      if (matchesDeleted > 0) {
        console.log(`[Tracker] Rolling DB: Deleted ${matchesDeleted} oldest finished matches, ${oddsDeleted} odds records (limit: ${maxMatches})`);
      }
    } catch (error) {
      console.error('[Tracker] Error enforcing match limit:', error);
    }
  }

  /**
   * Get goal line statistics for a specific league
   * Analyzes all odds history records to calculate hit rates and ROI by goal line
   */
  getLeagueGoalLineStats(leagueId: number): {
    totalMatches: number;
    goalLineStats: Array<{
      goalLine: number;
      timesAvailable: number;
      overHits: number;
      hitRate: number;
      roi: number;
    }>;
  } {
    // Get total finished matches for this league (only those with valid final scores)
    const totalStmt = db.prepare(
      "SELECT COUNT(*) as count FROM matches WHERE league_id = ? AND status = 'finished' AND final_score_home IS NOT NULL AND final_score_away IS NOT NULL"
    );
    const totalMatches = (totalStmt.get(leagueId) as any).count;

    // Get unique goal lines per match using GROUP BY (count each goal line only once per match)
    // Only include finished matches with valid final scores
    const oddsStmt = db.prepare(`
      SELECT
        oh.match_id,
        oh.handicap,
        m.final_score_home,
        m.final_score_away
      FROM odds_history oh
      JOIN matches m ON oh.match_id = m.match_id
      WHERE m.league_id = ?
        AND m.status = 'finished'
        AND m.final_score_home IS NOT NULL
        AND m.final_score_away IS NOT NULL
        AND oh.handicap IS NOT NULL
      GROUP BY oh.match_id, oh.handicap
    `);

    const oddsRows = oddsStmt.all(leagueId) as Array<{
      match_id: string;
      handicap: number;
      final_score_home: number | null;
      final_score_away: number | null;
    }>;

    // Group by goal line and calculate stats
    const goalLineMap = new Map<number, { total: number; hits: number }>();

    for (const row of oddsRows) {
      if (row.handicap === null || row.final_score_home === null || row.final_score_away === null) {
        continue;
      }

      const goalLine = row.handicap;
      const totalGoals = row.final_score_home + row.final_score_away;
      const overHit = totalGoals > goalLine;

      const existing = goalLineMap.get(goalLine) || { total: 0, hits: 0 };
      existing.total++;
      if (overHit) {
        existing.hits++;
      }
      goalLineMap.set(goalLine, existing);
    }

    // Convert to array and calculate hit rate and ROI
    const goalLineStats = Array.from(goalLineMap.entries())
      .map(([goalLine, data]) => {
        const hitRate = data.total > 0 ? (data.hits / data.total) * 100 : 0;
        // ROI at 1.90 odds: (hitRate/100 * 1.90 - 1) * 100
        const roi = hitRate * 1.9 - 100;
        return {
          goalLine,
          timesAvailable: data.total,
          overHits: data.hits,
          hitRate: Math.round(hitRate * 10) / 10,
          roi: Math.round(roi * 10) / 10,
        };
      })
      .sort((a, b) => a.goalLine - b.goalLine);

    return {
      totalMatches,
      goalLineStats,
    };
  }

  /**
   * Backfill missing scores for finished matches
   * This finds all finished matches with missing scores and tries to fetch results from BetsAPI
   */
  async backfillMissingScores(): Promise<{
    processed: number;
    updated: number;
    failed: number;
    details: Array<{ matchId: string; teams: string; result: string }>;
  }> {
    // Find finished matches with missing scores
    const stmt = db.prepare(`
      SELECT * FROM matches
      WHERE status = 'finished'
      AND (final_score_home IS NULL OR final_score_away IS NULL)
    `);
    const matchesWithMissingScores = stmt.all() as Match[];

    console.log(`[Backfill] Found ${matchesWithMissingScores.length} matches with missing scores`);

    let updated = 0;
    let failed = 0;
    const details: Array<{ matchId: string; teams: string; result: string }> = [];

    for (const match of matchesWithMissingScores) {
      try {
        // Try to fetch result from BetsAPI using bet365_id (which stores our_event_id)
        if (match.bet365_id) {
          const result = await betsapiService.getMatchResult(match.bet365_id);

          if (result?.ss) {
            const [home, away] = result.ss.split('-').map((s) => parseInt(s.trim(), 10));

            if (!isNaN(home) && !isNaN(away)) {
              // Update the match with the score
              const updateStmt = db.prepare(`
                UPDATE matches
                SET final_score_home = ?,
                    final_score_away = ?,
                    current_score = COALESCE(current_score, ?),
                    updated_at = datetime('now')
                WHERE match_id = ?
              `);
              updateStmt.run(home, away, result.ss, match.match_id);

              updated++;
              details.push({
                matchId: match.match_id,
                teams: `${match.home_team} vs ${match.away_team}`,
                result: `${home}-${away}`,
              });

              console.log(`[Backfill] Updated ${match.home_team} vs ${match.away_team}: ${home}-${away}`);
              continue;
            }
          }
        }

        // Failed to get score
        failed++;
        details.push({
          matchId: match.match_id,
          teams: `${match.home_team} vs ${match.away_team}`,
          result: 'NOT_FOUND',
        });
      } catch (error) {
        failed++;
        details.push({
          matchId: match.match_id,
          teams: `${match.home_team} vs ${match.away_team}`,
          result: 'ERROR',
        });
      }

      // Add a small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`[Backfill] Completed: ${updated} updated, ${failed} failed`);

    return {
      processed: matchesWithMissingScores.length,
      updated,
      failed,
      details,
    };
  }

  /**
   * Backfill missing goal line data for historical matches
   * This finds matches with null detected_odds and tries to fetch historical odds from BetsAPI
   */
  async backfillMissingGoalLines(): Promise<{
    processed: number;
    updated: number;
    touched15Found: number;
    failed: number;
    details: Array<{ matchId: string; teams: string; result: string; goalLine?: number; touched15?: boolean }>;
  }> {
    // Find matches with missing goal line data
    const stmt = db.prepare(`
      SELECT * FROM matches
      WHERE detected_odds IS NULL
      ORDER BY id DESC
      LIMIT 200
    `);
    const matchesWithMissingGoalLine = stmt.all() as Match[];

    console.log(`[Backfill GoalLine] Found ${matchesWithMissingGoalLine.length} matches with missing goal line`);

    let updated = 0;
    let touched15Found = 0;
    let failed = 0;
    const details: Array<{ matchId: string; teams: string; result: string; goalLine?: number; touched15?: boolean }> = [];

    for (const match of matchesWithMissingGoalLine) {
      try {
        // Try to get historical odds using the match_id (which should be a valid BetsAPI event ID)
        const oddsSummary = await betsapiService.getHistoricalOddsSummary(match.match_id);

        if (oddsSummary) {
          const goalLineData = betsapiService.extractHistoricalAsianGoalLine(oddsSummary);

          if (goalLineData) {
            // Update the match with goal line data
            const updateStmt = db.prepare(`
              UPDATE matches
              SET detected_odds = ?,
                  current_goal_line = ?,
                  touched_15 = ?,
                  updated_at = datetime('now')
              WHERE match_id = ?
            `);
            updateStmt.run(
              goalLineData.handicap,
              goalLineData.handicap,
              goalLineData.touched15 ? 1 : 0,
              match.match_id
            );

            updated++;
            if (goalLineData.touched15) {
              touched15Found++;
            }
            details.push({
              matchId: match.match_id,
              teams: `${match.home_team} vs ${match.away_team}`,
              result: 'UPDATED',
              goalLine: goalLineData.handicap,
              touched15: goalLineData.touched15,
            });

            console.log(`[Backfill GoalLine] Updated ${match.home_team} vs ${match.away_team}: Goal Line ${goalLineData.handicap}${goalLineData.touched15 ? ' (touched 1.5!)' : ''}`);
            continue;
          }
        }

        // Failed to get goal line data
        failed++;
        details.push({
          matchId: match.match_id,
          teams: `${match.home_team} vs ${match.away_team}`,
          result: 'NOT_FOUND',
        });
      } catch (error) {
        failed++;
        details.push({
          matchId: match.match_id,
          teams: `${match.home_team} vs ${match.away_team}`,
          result: 'ERROR',
        });
      }

      // Add a small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    console.log(`[Backfill GoalLine] Completed: ${updated} updated (${touched15Found} touched 1.5), ${failed} failed`);

    return {
      processed: matchesWithMissingGoalLine.length,
      updated,
      touched15Found,
      failed,
      details,
    };
  }
}

export const trackerService = new TrackerService();
export default trackerService;
