import { Router, Request, Response } from 'express';
import { trackerService } from '../services/tracker.service';
import { telegramService } from '../services/telegram.service';
import { authService } from '../services/auth.service';
import { config } from '../config';

const router = Router();

/**
 * POST /api/auth/signup - Register a new user
 */
router.post('/auth/signup', (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
      return;
    }

    const result = authService.signUp(email, password);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * POST /api/auth/login - Login user
 */
router.post('/auth/login', (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
      return;
    }

    const result = authService.login(email, password);

    if (!result.success) {
      res.status(401).json(result);
      return;
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * GET /api/health - Health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    trackerRunning: trackerService.isTrackerRunning(),
  });
});

/**
 * GET /api/tracked - Get currently tracked (live) matches
 */
router.get('/tracked', (req: Request, res: Response) => {
  try {
    const matches = trackerService.getAllMatches({ status: 'live' });
    res.json({
      success: true,
      count: matches.length,
      matches,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/history - Get historical matches
 */
router.get('/history', (req: Request, res: Response) => {
  try {
    const {
      status,
      league_id,
      limit = '50',
      offset = '0',
    } = req.query as Record<string, string>;

    const filterOptions = {
      status: status as 'live' | 'finished' | undefined,
      leagueId: league_id ? parseInt(league_id, 10) : undefined,
    };

    const matches = trackerService.getAllMatches({
      ...filterOptions,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    // Get total count for pagination (without limit/offset)
    const total = trackerService.getMatchesCount(filterOptions);

    res.json({
      success: true,
      count: matches.length,
      total,
      matches,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/stats - Get statistics
 */
router.get('/stats', (req: Request, res: Response) => {
  try {
    const stats = trackerService.getStats();

    // Add league names to stats
    const leagueStats = Object.entries(stats.byLeague).map(([leagueId, count]) => ({
      leagueId: parseInt(leagueId, 10),
      leagueName: config.leagueNames[parseInt(leagueId, 10)] || `League ${leagueId}`,
      count,
    }));

    res.json({
      success: true,
      stats: {
        ...stats,
        leagueStats,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/odds-history/:matchId - Get odds history for a match
 */
router.get('/odds-history/:matchId', (req: Request, res: Response) => {
  try {
    const { matchId } = req.params;
    const oddsHistory = trackerService.getOddsHistory(matchId);
    const match = trackerService.getMatch(matchId);

    if (!match) {
      res.status(404).json({
        success: false,
        error: 'Match not found',
      });
      return;
    }

    res.json({
      success: true,
      match,
      oddsHistory,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/leagues - Get target leagues
 */
router.get('/leagues', (req: Request, res: Response) => {
  const leagues = config.targetLeagues.map((id) => ({
    id,
    name: config.leagueNames[id] || `League ${id}`,
  }));

  res.json({
    success: true,
    leagues,
  });
});

/**
 * GET /api/league-stats/:leagueId - Get goal line statistics for a specific league
 */
router.get('/league-stats/:leagueId', (req: Request, res: Response) => {
  try {
    const leagueId = parseInt(req.params.leagueId, 10);
    if (isNaN(leagueId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid league ID',
      });
      return;
    }

    const stats = trackerService.getLeagueGoalLineStats(leagueId);
    res.json({
      success: true,
      leagueId,
      leagueName: config.leagueNames[leagueId] || `League ${leagueId}`,
      targetLine: config.targetGoalLines[leagueId] ?? 1.5,
      ...stats,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/tracker/start - Start the tracker
 */
router.post('/tracker/start', (req: Request, res: Response) => {
  try {
    trackerService.start();
    res.json({
      success: true,
      message: 'Tracker started',
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/tracker/stop - Stop the tracker
 */
router.post('/tracker/stop', (req: Request, res: Response) => {
  try {
    trackerService.stop();
    res.json({
      success: true,
      message: 'Tracker stopped',
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/telegram/test - Send test Telegram message
 */
router.post('/telegram/test', async (req: Request, res: Response) => {
  try {
    const success = await telegramService.sendTestMessage();
    res.json({
      success,
      message: success ? 'Test message sent' : 'Failed to send test message',
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/backfill-scores - Backfill missing scores for finished matches
 */
router.post('/backfill-scores', async (req: Request, res: Response) => {
  try {
    const result = await trackerService.backfillMissingScores();
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/backfill-goallines - Backfill missing goal line data for historical matches
 */
router.post('/backfill-goallines', async (req: Request, res: Response) => {
  try {
    const result = await trackerService.backfillMissingGoalLines();
    res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
