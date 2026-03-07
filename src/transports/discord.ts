import type { ITransportProvider } from "./interface.js";
import type { ExternalMessage } from "../types.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";

// Dynamic import for ESM modules
type Client = any;
type Message = any;

async function loadDiscordJS() {
  const discord = await import("discord.js");
  return discord;
}

/**
 * Discord transport provider using discord.js
 */
export class DiscordProvider implements ITransportProvider {
  readonly type = "discord";
  private client: Client | null = null;
  private _isConnected = false;
  private botUserId: string = "";
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;
  private lastProcessedMessageId = "";

  constructor(
    private config: { token: string },
    private auth: ChallengeAuth
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { token } = this.config;

    if (!token) {
      throw new Error("Discord bot token required");
    }

    const discord = await loadDiscordJS();

    this.client = new discord.Client({
      intents: [
        discord.GatewayIntentBits.Guilds,
        discord.GatewayIntentBits.GuildMessages,
        discord.GatewayIntentBits.DirectMessages,
        discord.GatewayIntentBits.MessageContent, // Privileged intent - must enable in Discord Developer Portal
      ],
      partials: [
        discord.Partials.Channel,
        discord.Partials.Message,
      ],
    });

    // Handle incoming messages
    this.client.on(discord.Events.MessageCreate, async (message: Message) => {
      // Ignore bot's own messages
      if (message.author.bot) {
        return;
      }

      // Skip empty messages (attachments only, etc.)
      if (!message.content) {
        return;
      }

      // Filter out duplicate messages
      if (message.id === this.lastProcessedMessageId) {
        return;
      }
      this.lastProcessedMessageId = message.id;

      // Detect if this is a DM
      const isDM = message.channel.type === discord.ChannelType.DM;

      // Detect bot mention: <@BOT_USER_ID> or <@!BOT_USER_ID> (nickname mention)
      const wasMentioned = this.botUserId
        ? message.content.includes(`<@${this.botUserId}>`) ||
          message.content.includes(`<@!${this.botUserId}>`) ||
          message.mentions.users.has(this.botUserId)
        : false;

      const userId = message.author.id;
      const chatId = message.channelId;
      const username = message.author.username;
      const text = message.content.trim();
      const isGroupChat = !isDM;

      // Check authorization
      const sendMessageToUser = async (cId: string, text: string) => {
        if (this.client) {
          const channel = await this.client.channels.fetch(cId);
          if (channel && "send" in channel) {
            await (channel as any).send(text);
          }
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

      // Handle admin commands and challenge codes in DM
      if (!isGroupChat && (text.startsWith("/") || text.match(/^\d{6}$/))) {
        const handled = await this.auth.handleAdminCommand(
          text,
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

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId,
          transport: this.type,
          content: text,
          username: username,
          userId: userId,
          timestamp: message.createdAt,
          messageId: message.id,
          isGroupChat,
          wasMentioned,
        };

        this.messageHandler(externalMessage);
      }
    });

    // Handle ready event
    this.client.once(discord.Events.ClientReady, (readyClient: any) => {
      this.botUserId = readyClient.user.id;
      console.log(`✅ Discord logged in as ${readyClient.user.tag} (ID: ${this.botUserId})`);
      this._isConnected = true;
    });

    // Handle errors
    this.client.on(discord.Events.Error, (error: Error) => {
      console.error("[Discord] Error:", error);
      if (this.errorHandler) {
        this.errorHandler(error);
      }
    });

    // Handle disconnection
    this.client.on(discord.Events.ShardDisconnect, () => {
      console.log("[Discord] Disconnected");
      this._isConnected = false;
    });

    try {
      await this.client.login(token);
    } catch (error) {
      console.error("[Discord] Failed to login:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this._isConnected = false;
    console.log("[Discord] Disconnected");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error("Discord not connected");
    }

    try {
      const channel = await this.client.channels.fetch(chatId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`Cannot send to channel ${chatId}`);
      }

      // Discord has 2000 char limit - split long messages
      const chunks = this.splitMessage(text, 2000);
      for (const chunk of chunks) {
        if ("send" in channel) {
          await (channel as any).send(chunk);
        }
      }
    } catch (error) {
      console.error("[Discord] Failed to send message:", error);
      throw error;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel && "sendTyping" in channel) {
        await (channel as any).sendTyping();
      }
    } catch (error) {
      console.warn("[Discord] Failed to send typing:", error);
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /**
   * Split a message into chunks that fit Discord's 2000 char limit.
   * Tries to split at newlines or spaces when possible.
   */
  private splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) {
      return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }

      // Try to find a good split point (newline or space)
      let splitAt = limit;
      const newlineIdx = remaining.lastIndexOf("\n", limit);
      const spaceIdx = remaining.lastIndexOf(" ", limit);

      if (newlineIdx > limit * 0.5) {
        splitAt = newlineIdx + 1;
      } else if (spaceIdx > limit * 0.5) {
        splitAt = spaceIdx + 1;
      }

      chunks.push(remaining.substring(0, splitAt).trimEnd());
      remaining = remaining.substring(splitAt).trimStart();
    }

    return chunks;
  }
}
