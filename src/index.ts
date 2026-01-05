import express from 'express';
import cors from 'cors';
import { config } from './config';
import { initializeDatabase } from './config/database';
import apiRoutes from './routes/api.routes';
import { trackerService } from './services/tracker.service';
import { telegramService } from './services/telegram.service';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Betting Monitor API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      tracked: '/api/tracked',
      history: '/api/history',
      stats: '/api/stats',
      leagues: '/api/leagues',
      oddsHistory: '/api/odds-history/:matchId',
      trackerStart: 'POST /api/tracker/start',
      trackerStop: 'POST /api/tracker/stop',
      telegramTest: 'POST /api/telegram/test',
    },
  });
});

// Initialize and start
async function bootstrap() {
  try {
    // Initialize database
    console.log('Initializing database...');
    initializeDatabase();

    // Start server - return a promise that resolves when server is listening
    const server = app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
      console.log(`BetsAPI configured: ${!!config.betsapi.token}`);
      console.log(`Telegram configured: ${!!config.telegram.botToken}`);
      console.log(`Target leagues: ${config.targetLeagues.join(', ')}`);
    });

    // Keep the server running
    server.on('close', () => {
      console.log('Server closed');
    });

    // Send startup notification (non-blocking)
    if (config.telegram.botToken) {
      telegramService.sendTestMessage().catch((err) => {
        console.error('Failed to send startup notification:', err);
      });
    }

    // Auto-start tracker in production
    if (config.nodeEnv === 'production') {
      console.log('Auto-starting tracker in production mode...');
      trackerService.start();
    } else {
      console.log('Development mode: Tracker not auto-started. Use POST /api/tracker/start to begin.');
    }

    return server;
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  trackerService.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  trackerService.stop();
  process.exit(0);
});

// Prevent process from exiting due to unhandled promise rejection
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Start the server
bootstrap().then((server) => {
  if (server) {
    console.log('Server started successfully, listening for requests...');
  }
}).catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
