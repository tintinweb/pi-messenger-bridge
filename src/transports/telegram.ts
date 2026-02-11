import TelegramBot from "node-telegram-bot-api";
import type { ITransportProvider } from "./interface.js";
import type { ExternalMessage } from "../types.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";

/**
 * Telegram transport provider using node-telegram-bot-api
 */
export class TelegramProvider implements ITransportProvider {
  readonly type = "telegram";
  private bot?: TelegramBot;
  private _isConnected = false;
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private lastProcessedMessageId = 0;

  constructor(
    private token: string,
    private auth: ChallengeAuth
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Convert standard markdown to Telegram markdown format
   * Telegram markdown: *bold* _italic_ `code` [link](url)
   * Standard markdown: **bold** *italic* `code` [link](url)
   */
  private formatForTelegram(text: string): string {
    // Escape special Telegram characters first (except those used in markdown)
    // Special chars that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
    // But we'll handle markdown-specific ones carefully
    
    // Step 1: Protect code blocks and inline code from conversion
    const codeBlocks: string[] = [];
    const inlineCodes: string[] = [];
    
    // Extract and protect code blocks
    text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
      codeBlocks.push(match);
      return `__CODEBLOCK_${codeBlocks.length - 1}__`;
    });
    
    // Extract and protect inline code
    text = text.replace(/`([^`]+)`/g, (match, code) => {
      inlineCodes.push(match);
      return `__INLINECODE_${inlineCodes.length - 1}__`;
    });
    
    // Step 2: Convert **bold** to *bold* (Telegram format)
    text = text.replace(/\*\*([^*]+?)\*\*/g, '*$1*');
    
    // Step 3: Convert *italic* to _italic_ (Telegram format)
    // But only single * not followed by another *
    text = text.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, '_$1_');
    
    // Step 4: Restore code blocks and inline code
    text = text.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx)]);
    text = text.replace(/__INLINECODE_(\d+)__/g, (_, idx) => inlineCodes[parseInt(idx)]);
    
    return text;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    this.bot = new TelegramBot(this.token, {
      polling: {
        interval: 300,
        autoStart: false,
      },
    });

    // Handle incoming messages
    this.bot.on("message", async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        if (this.errorHandler) {
          this.errorHandler(err as Error);
        }
      }
    });

    // Handle polling errors
    this.bot.on("polling_error", (err) => {
      if (this.errorHandler) {
        this.errorHandler(err);
      }
    });

    await this.bot.startPolling();
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected || !this.bot) return;

    await this.bot.stopPolling();
    this._isConnected = false;
    this.bot = undefined;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram bot not connected");
    }
    const formattedText = this.formatForTelegram(text);
    await this.bot.sendMessage(chatId, formattedText, { parse_mode: "Markdown" });
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendChatAction(chatId, "typing");
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    // Filter out old messages (prevent stale message processing on reconnect)
    if (msg.message_id <= this.lastProcessedMessageId) {
      return;
    }
    this.lastProcessedMessageId = msg.message_id;

    // Only process text messages
    if (!msg.text || !msg.from) {
      return;
    }

    const chatId = msg.chat.id.toString();
    const userId = msg.from.id.toString();
    const username = msg.from.username || msg.from.first_name || "unknown";
    const isGroupChat = msg.chat.type !== "private";

    // Check if bot was mentioned in group chat
    let wasMentioned = false;
    if (isGroupChat && this.bot) {
      const botInfo = await this.bot.getMe();
      const botUsername = botInfo.username;
      wasMentioned =
        msg.text.includes(`@${botUsername}`) ||
        (msg.entities?.some(
          (entity) =>
            entity.type === "mention" &&
            msg.text!.substring(entity.offset, entity.offset + entity.length) ===
              `@${botUsername}`
        ) ?? false);
    }

    // Check authorization (with sendMessage callback for challenge notifications)
    const sendMessageToUser = async (cId: string, text: string) => {
      if (this.bot) {
        await this.bot.sendMessage(cId, text, { parse_mode: "Markdown" });
      }
    };
    
    const isAuthorized = await this.auth.checkAuthorization(
      userId,
      chatId,
      username,
      isGroupChat,
      wasMentioned,
      sendMessageToUser,
      this.type
    );

    // Handle admin commands and challenge codes in DM (before auth check!)
    if (!isGroupChat && (msg.text.startsWith("/") || msg.text.match(/^\d{6}$/))) {
      const handled = await this.auth.handleAdminCommand(
        msg.text,
        chatId,
        userId,
        async (text) => await this.sendMessage(chatId, text),
        this.type
      );
      if (handled) {
        return;
      }
    }

    if (!isAuthorized) {
      return; // Auth handler already sent challenge/error messages
    }

    // Strip bot mention from message if present
    let content = msg.text;
    if (wasMentioned && this.bot) {
      const botInfo = await this.bot.getMe();
      const botUsername = botInfo.username;
      content = content.replace(new RegExp(`@${botUsername}\\s*`, "g"), "").trim();
    }

    // Forward to message handler
    if (this.messageHandler && content) {
      const externalMessage: ExternalMessage = {
        chatId,
        transport: this.type,
        content,
        username,
        userId,
        timestamp: new Date((msg.date || 0) * 1000),
        messageId: msg.message_id.toString(),
        isGroupChat,
        wasMentioned,
      };

      this.messageHandler(externalMessage);
    }
  }
}
