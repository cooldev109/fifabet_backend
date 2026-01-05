import axios, { AxiosInstance, AxiosError } from 'axios';
import { config } from '../config';
import db from '../config/database';
import {
  BetsAPIResponse,
  BetsAPIMatch,
  BetsAPIOddsSummary,
  BetsAPIResult,
  Bet365RawItem,
  Bet365RawInplayResponse,
  Bet365ParsedMatch,
} from '../models/types';

class BetsAPIService {
  private client: AxiosInstance;
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTTL = 10000; // 10 seconds cache

  constructor() {
    this.client = axios.create({
      baseURL: config.betsapi.baseUrl,
      timeout: 30000,
      params: {
        token: config.betsapi.token,
      },
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        this.logApiCall(
          response.config.url || '',
          response.status,
          Date.now() - (response.config as any).startTime
        );
        return response;
      },
      (error: AxiosError) => {
        this.logApiCall(
          error.config?.url || '',
          error.response?.status || 0,
          Date.now() - ((error.config as any)?.startTime || Date.now()),
          error.message
        );
        throw error;
      }
    );

    // Add request interceptor to track timing
    this.client.interceptors.request.use((config) => {
      (config as any).startTime = Date.now();
      return config;
    });
  }

  private logApiCall(
    endpoint: string,
    status: number,
    responseTime: number,
    errorMessage?: string
  ): void {
    try {
      const stmt = db.prepare(`
        INSERT INTO api_logs (endpoint, response_status, response_time_ms, error_message)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(endpoint, status, responseTime, errorMessage || null);
    } catch (error) {
      console.error('Failed to log API call:', error);
    }
  }

  private getCached<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data as T;
    }
    return null;
  }

  private setCache(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Get live matches filtered by league
   * Uses /v3/events/inplay endpoint from Soccer API
   */
  async getInplayMatches(leagueId: number): Promise<BetsAPIMatch[]> {
    const cacheKey = `inplay_${leagueId}`;
    const cached = this.getCached<BetsAPIMatch[]>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<BetsAPIResponse<BetsAPIMatch>>(
        '/v3/events/inplay',
        {
          params: {
            sport_id: 1, // Soccer
            league_id: leagueId,
          },
        }
      );

      const matches = response.data.results || [];
      this.setCache(cacheKey, matches);
      return matches;
    } catch (error) {
      console.error(`Error fetching inplay matches for league ${leagueId}:`, error);
      return [];
    }
  }

  /**
   * Get all live matches for target leagues (legacy method using inplay_filter)
   */
  async getAllInplayMatches(): Promise<BetsAPIMatch[]> {
    const allMatches: BetsAPIMatch[] = [];

    for (const leagueId of config.targetLeagues) {
      const matches = await this.getInplayMatches(leagueId);
      allMatches.push(...matches);
    }

    return allMatches;
  }

  /**
   * Get all live soccer matches from the API
   * Uses /v3/events/inplay endpoint - returns structured match data
   */
  async getRawBet365Inplay(): Promise<Bet365RawItem[]> {
    const cacheKey = 'raw_bet365_inplay';
    const cached = this.getCached<Bet365RawItem[]>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<BetsAPIResponse<BetsAPIMatch>>(
        '/v3/events/inplay',
        {
          params: {
            sport_id: 1, // Soccer
          },
        }
      );

      // Convert BetsAPIMatch to Bet365RawItem format for compatibility
      const matches = response.data.results || [];
      const items: Bet365RawItem[] = matches.map((match) => ({
        type: 'EV',
        ID: match.id,
        NA: `${match.home.name} v ${match.away.name}`,
        CT: match.league.name,
        SS: match.ss,
        TU: match.timer?.tm?.toString(),
        FI: match.bet365_id,
        league_id: match.league.id,
        home: match.home,
        away: match.away,
      }));

      this.setCache(cacheKey, items);
      console.log(`[BetsAPI] Inplay returned ${items.length} matches`);
      return items;
    } catch (error) {
      console.error('Error fetching inplay matches:', error);
      return [];
    }
  }

  /**
   * Parse raw bet365 data to extract target league matches
   * Updated to work with /v3/events/inplay response format
   */
  parseRawBet365Data(rawItems: Bet365RawItem[]): Bet365ParsedMatch[] {
    const matchesMap = new Map<string, Bet365ParsedMatch>();

    for (const item of rawItems) {
      if (item.type !== 'EV' || !item.ID) continue;

      // Check if this league matches any of our target leagues by ID or pattern
      const leagueId = parseInt(item.league_id as string, 10);
      const leagueName = item.CT || '';

      let matchedLeague: { name: string; id: number } | null = null;

      // First check by league ID
      if (config.targetLeagues.includes(leagueId)) {
        matchedLeague = {
          name: config.leagueNames[leagueId] || leagueName,
          id: leagueId
        };
      } else {
        // Fall back to pattern matching
        for (const pattern of config.bet365LeaguePatterns) {
          if (pattern.pattern.test(leagueName)) {
            matchedLeague = { name: pattern.name, id: pattern.leagueId };
            break;
          }
        }
      }

      if (!matchedLeague) continue;

      const eventId = item.ID;
      if (matchesMap.has(eventId)) continue;

      // Get team names from the item
      const home = (item as any).home;
      const away = (item as any).away;

      let homeTeam = 'Unknown';
      let awayTeam = 'Unknown';

      if (home && away) {
        homeTeam = home.name || 'Unknown';
        awayTeam = away.name || 'Unknown';
      } else if (item.NA) {
        // Parse from match name
        const teams = item.NA.split(/\s+(?:v|vs|-)(?:\s+|\s*)/i);
        if (teams.length >= 2) {
          homeTeam = teams[0].trim();
          awayTeam = teams[1].trim();
        }
      }

      matchesMap.set(eventId, {
        id: eventId,
        bet365Id: item.FI || item.ID,
        leagueName: matchedLeague.name,
        leagueId: matchedLeague.id,
        homeTeam,
        awayTeam,
        score: item.SS,
        minute: item.TU,
      });
    }

    const matches = Array.from(matchesMap.values());
    console.log(`[Parser] Found ${matches.length} unique matches in target leagues`);
    return matches;
  }

  /**
   * Get all live matches from target leagues using raw bet365 data
   * This is the new method that parses raw bet365 format
   */
  async getTargetLeagueMatches(): Promise<Bet365ParsedMatch[]> {
    const rawData = await this.getRawBet365Inplay();
    return this.parseRawBet365Data(rawData);
  }

  /**
   * Get odds summary for a specific event using our_event_id
   * This returns odds including Asian Goal Line (1_3 market)
   */
  async getOddsSummary(ourEventId: string): Promise<any | null> {
    const cacheKey = `odds_${ourEventId}`;
    const cached = this.getCached<any>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<{ success: number; results: any }>(
        '/v2/event/odds/summary',
        {
          params: {
            event_id: ourEventId,
          },
        }
      );

      if (response.data.success === 1) {
        const oddsSummary = response.data.results;
        this.setCache(cacheKey, oddsSummary);
        return oddsSummary;
      }
      return null;
    } catch (error) {
      console.error(`Error fetching odds summary for event ${ourEventId}:`, error);
      return null;
    }
  }

  /**
   * Get bet365 prematch odds for Asian total goals
   * This is an alternative method when odds/summary doesn't work
   */
  async getBet365Odds(bet365EventId: string): Promise<any | null> {
    const cacheKey = `bet365_odds_${bet365EventId}`;
    const cached = this.getCached<any>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<{ success: number; results: any }>(
        '/v1/bet365/event',
        {
          params: {
            FI: bet365EventId,
          },
        }
      );

      if (response.data.success === 1) {
        const oddsData = response.data.results;
        this.setCache(cacheKey, oddsData);
        return oddsData;
      }
      return null;
    } catch (error) {
      // Don't log error for this alternative method - it's expected to fail sometimes
      return null;
    }
  }

  /**
   * Extract Asian Total Goals from bet365 event odds
   * Looking for "Asian Total Goals" market in the response
   */
  extractBet365AsianGoalLine(bet365OddsData: any): {
    handicap: number;
    overOdds: string;
    underOdds: string;
  } | null {
    try {
      if (!bet365OddsData || !Array.isArray(bet365OddsData)) return null;

      // Look for Asian Total Goals market in the response
      for (const item of bet365OddsData) {
        // Check if this is the Asian Total Goals market (type "MG" with NA containing "Asian Total")
        if (item.type === 'MG' && item.NA && item.NA.toLowerCase().includes('asian total')) {
          // Find the odds within this market group
          continue;
        }

        // Check for goal line items (type "PA" for participants/odds)
        if (item.type === 'PA' && item.OD && item.HD) {
          const handicap = parseFloat(item.HD);
          if (!isNaN(handicap)) {
            // This might be a goal line item
            return {
              handicap,
              overOdds: item.OD || 'N/A',
              underOdds: 'N/A', // Will need to find the under odds from another item
            };
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get match result/details
   * Uses /v1/event/view endpoint from Soccer API
   */
  async getMatchResult(eventId: string): Promise<BetsAPIResult | null> {
    try {
      const response = await this.client.get<{ success: number; results: BetsAPIResult[] }>(
        '/v1/event/view',
        {
          params: {
            event_id: eventId,
          },
        }
      );

      if (response.data.success === 1 && response.data.results?.length) {
        return response.data.results[0];
      }
      return null;
    } catch (error) {
      console.error(`Error fetching result for event ${eventId}:`, error);
      return null;
    }
  }

  /**
   * Extract Asian Goal Line from odds summary
   * The 1_3 market is Over/Under Total Goals (Asian Goal Line)
   * Structure: results.Bet365.odds.end['1_3'] = { handicap, over_od, under_od }
   */
  extractAsianGoalLine(oddsSummary: any): {
    handicap: number;
    overOdds: string;
    underOdds: string;
    score: string;
  } | null {
    try {
      const bet365 = oddsSummary?.Bet365;
      if (!bet365?.odds) return null;

      // Get the latest odds (from 'end' which has most recent data)
      const latestOdds = bet365.odds.end?.['1_3'] || bet365.odds.kickoff?.['1_3'] || bet365.odds.start?.['1_3'];

      if (latestOdds && latestOdds.handicap) {
        return {
          handicap: parseFloat(latestOdds.handicap),
          overOdds: latestOdds.over_od || 'N/A',
          underOdds: latestOdds.under_od || 'N/A',
          score: latestOdds.ss || 'N/A',
        };
      }

      return null;
    } catch (error) {
      console.error('Error extracting Asian Goal Line:', error);
      return null;
    }
  }

  /**
   * Get Asian Goal Line data for a match
   * Uses our_event_id from inplay_filter response
   * Returns the current goal line value - target checking is done in tracker service per league
   */
  async checkAsianGoalLine(
    ourEventId: string
  ): Promise<{
    handicap: number;
    overOdds: string;
    underOdds: string;
    score: string;
  } | null> {
    const oddsSummary = await this.getOddsSummary(ourEventId);
    if (!oddsSummary) {
      console.log(`[BetsAPI] No odds summary for event ${ourEventId}`);
      return null;
    }

    const goalLine = this.extractAsianGoalLine(oddsSummary);
    if (!goalLine) {
      // Log available markets for debugging
      const bet365 = oddsSummary?.Bet365;
      if (bet365?.odds) {
        const availableMarkets = Object.keys(bet365.odds.end || bet365.odds.kickoff || bet365.odds.start || {});
        console.log(`[BetsAPI] No 1_3 market for event ${ourEventId}. Available markets: ${availableMarkets.join(', ')}`);
      } else {
        console.log(`[BetsAPI] No Bet365 odds data for event ${ourEventId}`);
      }
      return null;
    }

    return {
      handicap: goalLine.handicap,
      overOdds: goalLine.overOdds,
      underOdds: goalLine.underOdds,
      score: goalLine.score,
    };
  }

  /**
   * Get live matches from inplay with event IDs for odds lookup
   * Uses /v3/events/inplay endpoint from Soccer API
   */
  async getInplayFilterMatches(): Promise<Array<{
    id: string;
    ourEventId: string;
    bet365Id: string;
    leagueId: number;
    leagueName: string;
    homeTeam: string;
    awayTeam: string;
    score: string;
  }>> {
    const cacheKey = 'inplay_filter_matches';
    const cached = this.getCached<any[]>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<BetsAPIResponse<BetsAPIMatch>>(
        '/v3/events/inplay',
        {
          params: {
            sport_id: 1, // Soccer
          },
        }
      );

      const results = response.data.results || [];
      const targetMatches: any[] = [];

      for (const match of results) {
        const leagueId = parseInt(match.league?.id || '0', 10);
        const leagueName = match.league?.name || '';

        // Check if this league matches our target leagues by ID
        if (config.targetLeagues.includes(leagueId)) {
          targetMatches.push({
            id: match.id,
            ourEventId: match.id, // In Soccer API, the event ID is used for odds lookup
            bet365Id: match.bet365_id || match.id,
            leagueId: leagueId,
            leagueName: config.leagueNames[leagueId] || leagueName,
            homeTeam: match.home?.name || 'Unknown',
            awayTeam: match.away?.name || 'Unknown',
            score: match.ss || '0-0',
          });
          continue;
        }

        // Fall back to pattern matching for league names
        for (const pattern of config.bet365LeaguePatterns) {
          if (pattern.pattern.test(leagueName)) {
            targetMatches.push({
              id: match.id,
              ourEventId: match.id,
              bet365Id: match.bet365_id || match.id,
              leagueId: pattern.leagueId,
              leagueName: pattern.name,
              homeTeam: match.home?.name || 'Unknown',
              awayTeam: match.away?.name || 'Unknown',
              score: match.ss || '0-0',
            });
            break;
          }
        }
      }

      this.setCache(cacheKey, targetMatches);
      console.log(`[BetsAPI] Found ${targetMatches.length} target league matches from inplay`);
      return targetMatches;
    } catch (error) {
      console.error('Error fetching inplay matches:', error);
      return [];
    }
  }

  /**
   * Get bet365 prematch odds for a specific event
   * This can be used as a fallback to get Asian Goal Line odds
   */
  async getBet365PrematchOdds(eventId: string): Promise<any | null> {
    const cacheKey = `prematch_odds_${eventId}`;
    const cached = this.getCached<any>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<{ success: number; results: any }>(
        '/v3/bet365/prematch_odds',
        {
          params: {
            FI: eventId,
          },
        }
      );

      if (response.data.success === 1) {
        const oddsData = response.data.results;
        this.setCache(cacheKey, oddsData);
        return oddsData;
      }
      return null;
    } catch (error) {
      // Silently fail - this is a fallback method
      return null;
    }
  }

  /**
   * Extract Asian Goal Line from bet365 prematch odds
   * Looking for market type "Asian Total Goals" (market_id typically 10120 or similar)
   */
  extractPrematchAsianGoalLine(prematchData: any): {
    handicap: number;
    overOdds: string;
    underOdds: string;
  } | null {
    try {
      if (!prematchData?.odds) return null;

      // Look for Asian Total Goals market
      for (const market of Object.values(prematchData.odds) as any[]) {
        if (market?.market_name?.toLowerCase().includes('asian total') ||
            market?.market_name?.toLowerCase().includes('over/under')) {
          // Find the odds entries
          if (market.odds && Array.isArray(market.odds)) {
            for (const odd of market.odds) {
              if (odd.handicap && odd.over_od) {
                return {
                  handicap: parseFloat(odd.handicap),
                  overOdds: odd.over_od,
                  underOdds: odd.under_od || 'N/A',
                };
              }
            }
          }
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get historical odds summary for a finished match
   * Returns odds at start, kickoff, and end of match
   */
  async getHistoricalOddsSummary(eventId: string): Promise<any | null> {
    try {
      const response = await this.client.get<{ success: number; results: any }>(
        '/v2/event/odds/summary',
        {
          params: {
            event_id: eventId,
          },
        }
      );

      if (response.data.success === 1) {
        return response.data.results;
      }
      return null;
    } catch (error) {
      // Silently fail - odds may not be available for old matches
      return null;
    }
  }

  /**
   * Extract Asian Goal Line from historical odds summary
   * Returns the starting goal line handicap from market 1_3
   */
  extractHistoricalAsianGoalLine(oddsSummary: any): {
    handicap: number;
    overOdds: string;
    underOdds: string;
    touched15: boolean;
  } | null {
    try {
      // Check Bet365 odds first
      const bet365 = oddsSummary?.Bet365;
      if (!bet365?.odds) return null;

      // Check if goal line 1.5 was ever touched during the match
      let touched15 = false;
      let startHandicap: number | null = null;
      let startOverOdds = 'N/A';
      let startUnderOdds = 'N/A';

      // Check start odds (market 1_3 = Asian Goal Line)
      if (bet365.odds.start?.['1_3']) {
        const startOdds = bet365.odds.start['1_3'];
        const handicap = startOdds.handicap;

        if (handicap) {
          // Handle handicap formats like "1.5,2.0" or "1.5" or "1.75"
          const handicapValue = handicap.includes(',')
            ? parseFloat(handicap.split(',')[0])
            : parseFloat(handicap);

          if (!isNaN(handicapValue)) {
            startHandicap = handicapValue;
            startOverOdds = startOdds.over_od || 'N/A';
            startUnderOdds = startOdds.under_od || 'N/A';

            if (handicapValue === 1.5) {
              touched15 = true;
            }
          }
        }
      }

      // Check kickoff odds
      if (bet365.odds.kickoff?.['1_3']) {
        const kickoffOdds = bet365.odds.kickoff['1_3'];
        const handicap = kickoffOdds.handicap;

        if (handicap) {
          const handicapValue = handicap.includes(',')
            ? parseFloat(handicap.split(',')[0])
            : parseFloat(handicap.replace('+', ''));

          if (!isNaN(handicapValue) && handicapValue === 1.5) {
            touched15 = true;
          }

          // Use kickoff handicap if no start handicap
          if (startHandicap === null) {
            startHandicap = handicapValue;
            startOverOdds = kickoffOdds.over_od || 'N/A';
            startUnderOdds = kickoffOdds.under_od || 'N/A';
          }
        }
      }

      // Check end odds
      if (bet365.odds.end?.['1_3']) {
        const endOdds = bet365.odds.end['1_3'];
        const handicap = endOdds.handicap;

        if (handicap) {
          const handicapValue = handicap.includes(',')
            ? parseFloat(handicap.split(',')[0])
            : parseFloat(handicap.replace('+', ''));

          if (!isNaN(handicapValue) && handicapValue === 1.5) {
            touched15 = true;
          }
        }
      }

      if (startHandicap === null) return null;

      return {
        handicap: startHandicap,
        overOdds: startOverOdds,
        underOdds: startUnderOdds,
        touched15,
      };
    } catch (error) {
      return null;
    }
  }
}

export const betsapiService = new BetsAPIService();
export default betsapiService;
