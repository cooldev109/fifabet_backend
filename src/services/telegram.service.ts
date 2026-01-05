import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { Match, OddsHistory } from '../models/types';

class TelegramService {
  private bot: TelegramBot | null = null;
  private messageQueue: Array<{ chatId: string; message: string; retries: number }> = [];
  private isProcessingQueue = false;
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor() {
    if (config.telegram.botToken) {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: false });
      console.log('Telegram bot initialized');
    } else {
      console.warn('Telegram bot token not configured');
    }
  }

  /**
   * Format detection alert message
   */
  private formatDetectionAlert(match: Match, oddsHistory?: OddsHistory[]): string {
    const leagueName = config.leagueNames[match.league_id] || `League ${match.league_id}`;
    const detectionTime = new Date(match.detection_time).toLocaleString();

    let oddsHistoryText = '';
    if (oddsHistory && oddsHistory.length > 0) {
      const lastOdds = oddsHistory.slice(-5); // Last 5 odds movements
      oddsHistoryText = lastOdds
        .map((o) => `  ${o.handicap} @ ${o.add_time || 'N/A'}`)
        .join('\n');
    }

    return `🚨 *ALERT: Asian 1.5 Detected!*

📋 *League:* ${leagueName}
⚽ *Match:* ${match.home_team} vs ${match.away_team}
🕐 *Detection Time:* ${detectionTime}
📊 *Current Odds:* ${match.detected_odds || 'N/A'}

${oddsHistoryText ? `📈 *Odds History:*\n${oddsHistoryText}` : ''}

🆔 Match ID: \`${match.match_id}\``;
  }

  /**
   * Format result alert message
   */
  private formatResultAlert(match: Match): string {
    const leagueName = config.leagueNames[match.league_id] || `League ${match.league_id}`;
    const endTime = match.match_end_time
      ? new Date(match.match_end_time).toLocaleString()
      : 'N/A';

    return `✅ *RESULT: Match Finished*

📋 *League:* ${leagueName}
⚽ *Match:* ${match.home_team} vs ${match.away_team}
🏆 *Final Score:* ${match.final_score_home ?? '?'} - ${match.final_score_away ?? '?'}
🕐 *End Time:* ${endTime}
📊 *Asian Line at Detection:* ${match.detected_odds || 'N/A'}

🆔 Match ID: \`${match.match_id}\``;
  }

  /**
   * Send detection alert
   */
  async sendDetectionAlert(match: Match, oddsHistory?: OddsHistory[]): Promise<boolean> {
    const message = this.formatDetectionAlert(match, oddsHistory);
    return this.sendMessage(message);
  }

  /**
   * Send result alert
   */
  async sendResultAlert(match: Match): Promise<boolean> {
    const message = this.formatResultAlert(match);
    return this.sendMessage(message);
  }

  /**
   * Format new match tracking alert
   */
  private formatNewMatchAlert(match: Match, leagueName: string): string {
    const detectionTime = new Date(match.detection_time).toLocaleString();

    return `📊 *New Match Tracking*

📋 *League:* ${leagueName}
⚽ *Match:* ${match.home_team} vs ${match.away_team}
🕐 *Started:* ${detectionTime}

🆔 Match ID: \`${match.match_id}\``;
  }

  /**
   * Send new match tracking alert
   */
  async sendNewMatchAlert(match: Match, leagueName: string): Promise<boolean> {
    const message = this.formatNewMatchAlert(match, leagueName);
    return this.sendMessage(message);
  }

  /**
   * Format target goal line detection alert (league-specific)
   */
  private formatTargetDetectionAlert(
    match: Match,
    goalLineResult: {
      handicap: number;
      overOdds: string;
      underOdds: string;
      score: string;
    },
    targetGoalLine: number
  ): string {
    const leagueName = config.leagueNames[match.league_id] || `League ${match.league_id}`;
    const detectionTime = new Date(match.detection_time).toLocaleString();

    return `🚨🚨🚨 *TARGET GOAL LINE ${targetGoalLine} DETECTED!* 🚨🚨🚨

📋 *League:* ${leagueName}
⚽ *Match:* ${match.home_team} vs ${match.away_team}
🎯 *Current Score:* ${goalLineResult.score}

📊 *Asian Goal Line:* ${goalLineResult.handicap}
   ⬆️ Over ${targetGoalLine}: ${goalLineResult.overOdds}
   ⬇️ Under ${targetGoalLine}: ${goalLineResult.underOdds}

🕐 *Detection Time:* ${detectionTime}
🆔 Match ID: \`${match.match_id}\`

⚡ *Action Required!*`;
  }

  /**
   * Send target goal line detection alert (league-specific)
   */
  async sendTargetDetectionAlert(
    match: Match,
    goalLineResult: {
      handicap: number;
      overOdds: string;
      underOdds: string;
      score: string;
    },
    targetGoalLine: number
  ): Promise<boolean> {
    const message = this.formatTargetDetectionAlert(match, goalLineResult, targetGoalLine);
    return this.sendMessage(message);
  }

  /**
   * Send message with retry logic
   */
  async sendMessage(message: string, chatId?: string): Promise<boolean> {
    const targetChatId = chatId || config.telegram.chatId;

    if (!this.bot || !targetChatId) {
      console.error('Telegram bot not configured or chat ID missing');
      return false;
    }

    this.messageQueue.push({ chatId: targetChatId, message, retries: 0 });
    this.processQueue();
    return true;
  }

  /**
   * Process message queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.messageQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.messageQueue.length > 0) {
      const item = this.messageQueue.shift();
      if (!item) continue;

      try {
        await this.bot!.sendMessage(item.chatId, item.message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        console.log(`Telegram message sent to ${item.chatId}`);
      } catch (error: any) {
        console.error(`Failed to send Telegram message:`, error.message);

        if (item.retries < this.maxRetries) {
          item.retries++;
          this.messageQueue.push(item);
          await this.delay(this.retryDelay * item.retries);
        } else {
          console.error(`Max retries reached for message to ${item.chatId}`);
        }
      }

      // Rate limiting - wait 100ms between messages
      await this.delay(100);
    }

    this.isProcessingQueue = false;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Send test message
   */
  async sendTestMessage(): Promise<boolean> {
    return this.sendMessage('🤖 Betting Monitor Bot is online and working!');
  }
}

export const telegramService = new TelegramService();
export default telegramService;
