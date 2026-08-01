import type { ChallengeAuth } from "../auth/challenge-auth.js";
import type { ExternalMessage } from "../types.js";
import type { ITransportProvider } from "./interface.js";

// Dynamic import for ESM modules
type App = any;

async function loadSlackBolt() {
  const slack = await import("@slack/bolt");
  return slack;
}

/**
 * Slack transport provider using @slack/bolt
 */
export class SlackProvider implements ITransportProvider {
  readonly type = "slack";
  private app: App | null = null;
  private _isConnected = false;
  private botUserId: string = "";
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private lastProcessedMessageId = "";
  
  // Cache user info to avoid repeated API calls
  private userCache: Map<string, string> = new Map();
  // Cache channel info to detect DMs vs channels
  private channelCache: Map<string, { isDM: boolean; name?: string }> = new Map();

  constructor(
    private config: { botToken: string; appToken: string },
    private auth: ChallengeAuth
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { botToken, appToken } = this.config;

    if (!botToken || !appToken) {
      throw new Error("Slack requires both botToken (xoxb-...) and appToken (xapp-...)");
    }

    const slack = await loadSlackBolt();

    this.app = new slack.App({
      token: botToken,
      appToken: appToken,
      socketMode: true,
      logLevel: slack.LogLevel.WARN,
    });

    // Get bot's own user ID for mention detection
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id || "";
      console.log(`[Slack] Bot user ID: ${this.botUserId}`);
    } catch (e) {
      console.warn("[Slack] Could not get bot info:", e);
    }

    // Register Slack-native slash commands for the same admin surface that
    // message-based DMs use. The app manifest declares these so they appear in
    // Slack's command picker; Socket Mode delivers invocations here.
    const adminCommands = [
      "/help",
      "/trusted",
      "/revoke",
      "/channels",
      "/enable",
      "/disable",
      "/toggletools",
    ];
    for (const commandName of adminCommands) {
      this.app.command(commandName, async (args: any) => {
        await this.handleAdminSlashCommand(args);
      });
    }

    // Listen for all messages
    this.app.message(async ({ message, client }: any) => {
      // Skip bot messages, message edits, deletes, etc.
      if (message.subtype) {
        return;
      }

      // TypeScript type guard for regular messages
      if (!("user" in message) || !("text" in message) || !message.text) {
        return;
      }

      const userId = message.user;
      const channelId = message.channel;
      const text = message.text;
      const ts = message.ts;
      // Anchor replies to the triggering message's thread. If the message is
      // already inside a thread, keep replying in that same thread (thread_ts)
      // instead of spawning a sibling; otherwise the message's own ts is the anchor.
      // Bolt's narrowed message type may not expose thread_ts, so cast.
      const threadTs = (message as any).thread_ts ?? ts;

      // Filter out duplicate messages
      if (ts === this.lastProcessedMessageId) {
        return;
      }
      this.lastProcessedMessageId = ts;

      // Get username from cache or fetch
      let username: string = this.userCache.get(userId) || userId;
      if (!this.userCache.has(userId)) {
        try {
          const userInfo = await client.users.info({ user: userId });
          const fetchedName = userInfo.user?.real_name || userInfo.user?.name;
          if (fetchedName) {
            username = fetchedName;
            this.userCache.set(userId, username);
          }
        } catch {
          username = userId;
        }
      }

      // Get channel info from cache or fetch (to detect DM vs channel)
      let channelInfo = this.channelCache.get(channelId);
      if (!channelInfo) {
        try {
          const convInfo = await client.conversations.info({ channel: channelId });
          const conv = convInfo.channel;
          // is_im = direct message, is_mpim = multi-party DM
          const isDM = conv?.is_im === true || conv?.is_mpim === true;
          const name = conv?.name || (isDM ? "DM" : channelId);
          channelInfo = { isDM, name };
          this.channelCache.set(channelId, channelInfo);
        } catch {
          // Default to assuming it's a DM if we can't fetch info
          channelInfo = { isDM: true };
          this.channelCache.set(channelId, channelInfo);
        }
      }

      // Detect bot mention: <@BOT_USER_ID>
      const wasMentioned = this.botUserId 
        ? text.includes(`<@${this.botUserId}>`)
        : false;

      const isGroupChat = !channelInfo.isDM;

      // Check authorization
      const sendMessageToUser = async (cId: string, text: string) => {
        if (this.app) {
          await this.app.client.chat.postMessage({
            channel: cId,
            text: text,
          });
        }
      };

      const isAuthorized = await this.auth.checkAuthorization(
        userId,
        channelId,
        username,
        isGroupChat,
        wasMentioned,
        sendMessageToUser,
        this.type
      );

      // Handle admin commands and challenge codes in DM
      if (!isGroupChat && (text.startsWith("/") || text.match(/^\d{6}$/))) {
        const handled = await this.auth.handleAdminCommand(
          text,
          channelId,
          userId,
          async (text) => await this.sendMessage(channelId, text),
          this.type
        );
        if (handled) {
          return;
        }
      }

      if (!isAuthorized) {
        return; // Auth handler already sent challenge/error messages
      }

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId: channelId,
          transport: this.type,
          content: text.trim(),
          username: username,
          userId: userId,
          timestamp: new Date(parseFloat(ts) * 1000),
          messageId: ts,
          isGroupChat,
          wasMentioned,
          // Thread replies in channels only; DMs stay flat.
          threadId: isGroupChat ? threadTs : undefined,
        };

        this.messageHandler(externalMessage);
      }
    });

    // Handle errors
    this.app.error(async (error: any) => {
      console.error("[Slack] Error:", error);
      if (this.errorHandler) {
        this.errorHandler(new Error(String(error)));
      }
    });

    try {
      await this.app.start();
      this._isConnected = true;
    } catch (error) {
      throw new Error(`Slack connection failed: ${(error as Error).message}`);
    }
  }

  private async handleAdminSlashCommand({ command, ack, respond, client }: any): Promise<void> {
    await ack();

    const channelId = command.channel_id;
    const userId = command.user_id;
    const username = command.user_name || userId;
    const args = command.text?.trim();
    const text = args ? `${command.command} ${args}` : command.command;

    let channelInfo = this.channelCache.get(channelId);
    if (!channelInfo) {
      try {
        const convInfo = await client.conversations.info({ channel: channelId });
        const conv = convInfo.channel;
        const isDM = conv?.is_im === true || conv?.is_mpim === true;
        const name = conv?.name || (isDM ? "DM" : channelId);
        channelInfo = { isDM, name };
        this.channelCache.set(channelId, channelInfo);
      } catch {
        channelInfo = { isDM: true };
        this.channelCache.set(channelId, channelInfo);
      }
    }

    const reply = async (messageText: string) => {
      await respond({ text: messageText, response_type: "ephemeral" });
    };

    if (!channelInfo.isDM) {
      await reply("Admin commands are DM-only. Open a direct message with the bot and try again.");
      return;
    }

    const isAuthorized = await this.auth.checkAuthorization(
      userId,
      channelId,
      username,
      false,
      false,
      async (_cId: string, messageText: string) => await reply(messageText),
      this.type
    );
    if (!isAuthorized) return;

    const handled = await this.auth.handleAdminCommand(
      text,
      channelId,
      userId,
      async (messageText) => await reply(messageText),
      this.type
    );
    if (!handled) {
      await reply("Unknown admin command. Use `/help` for the command list.");
    }
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch {
        // Ignore stop errors
      }
      this.app = null;
    }
    this._isConnected = false;
    this.userCache.clear();
    this.channelCache.clear();
    console.log("[Slack] Disconnected");
  }

  async sendMessage(chatId: string, text: string, threadId?: string): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }
    if (!text?.trim()) return;

    try {
      await this.app.client.chat.postMessage({
        channel: chatId,
        text: text,
        ...(threadId ? { thread_ts: threadId } : {}),
      });
    } catch (error) {
      throw new Error(`Slack send failed: ${(error as Error).message}`);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't support typing indicators for bots
    // We could potentially add a reaction or use a "thinking" message
    // but for now we'll just skip it
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
