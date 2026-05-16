import type { ChallengeAuth } from "../auth/challenge-auth.js";
import type { ExternalMessage } from "../types.js";
import type { ITransportProvider } from "./interface.js";

// Dynamic import for ESM modules
type App = any;

type SlackImageAttachment = {
  data: string;
  mimeType: string;
  name?: string;
};

const MAX_SLACK_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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
  private activeBrainReactions = new Set<string>();
  
  // Cache user info to avoid repeated API calls
  private userCache: Map<string, string> = new Map();
  // Cache channel info to detect DMs vs channels
  private channelCache: Map<string, { isDM: boolean; name?: string }> = new Map();

  constructor(
    private config: { botToken: string; appToken: string; brainReaction?: boolean; debug?: boolean },
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

    // Listen for all messages
    this.app.message(async ({ message, client }: any) => {
      // Skip bot messages, message edits, deletes, etc. Slack file uploads arrive as
      // `file_share` subtype messages, so keep those and process their image files.
      if (message.subtype && message.subtype !== "file_share") {
        return;
      }

      const files = Array.isArray(message.files) ? message.files : [];
      const hasImageFiles = files.some((file: any) => this.isSupportedSlackImage(file));

      // TypeScript type guard for regular or image-bearing messages.
      if (!("user" in message) || !("channel" in message) || !("ts" in message)) {
        return;
      }

      const rawText = typeof message.text === "string" ? message.text : "";
      if (!rawText.trim() && !hasImageFiles) {
        return;
      }

      const userId = message.user;
      const channelId = message.channel;
      const text = rawText;
      const ts = message.ts;

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

      if (this.config.brainReaction === true) {
        await this.setMessageProcessing(channelId, ts, true);
      }

      const images = hasImageFiles ? await this.downloadSlackImages(files) : [];
      const content = this.formatMessageContent(text, files, images);

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId: channelId,
          transport: this.type,
          content,
          images,
          username: username,
          userId: userId,
          timestamp: new Date(parseFloat(ts) * 1000),
          messageId: ts,
          isGroupChat,
          wasMentioned,
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
    this.activeBrainReactions.clear();
    console.log("[Slack] Disconnected");
  }

  private isSupportedSlackImage(file: any): boolean {
    const mimeType = typeof file?.mimetype === "string" ? file.mimetype.toLowerCase() : "";
    return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
  }

  private async downloadSlackImages(files: any[]): Promise<SlackImageAttachment[]> {
    const images: SlackImageAttachment[] = [];

    for (const file of files) {
      if (!this.isSupportedSlackImage(file)) continue;

      const downloadUrl = file.url_private_download || file.url_private;
      const mimeType = String(file.mimetype).toLowerCase();
      if (!downloadUrl) continue;

      try {
        const response = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${this.config.botToken}` },
        });

        if (!response.ok) {
          console.warn(`[Slack] Failed to download image ${file.id || file.name}: HTTP ${response.status}`);
          continue;
        }

        const contentLength = Number(response.headers.get("content-length") || "0");
        if (contentLength > MAX_SLACK_IMAGE_BYTES) {
          console.warn(`[Slack] Skipping image ${file.id || file.name}: file is too large`);
          continue;
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_SLACK_IMAGE_BYTES) {
          console.warn(`[Slack] Skipping image ${file.id || file.name}: file is too large`);
          continue;
        }

        images.push({
          data: Buffer.from(arrayBuffer).toString("base64"),
          mimeType,
          name: file.name || file.title,
        });
      } catch (error) {
        console.warn(`[Slack] Failed to download image ${file.id || file.name}: ${(error as Error).message}`);
      }
    }

    return images;
  }

  private formatMessageContent(text: string, files: any[], images: SlackImageAttachment[]): string {
    const trimmed = text.trim();
    const supportedImageCount = files.filter((file: any) => this.isSupportedSlackImage(file)).length;

    if (images.length === 0 && supportedImageCount > 0) {
      const plural = supportedImageCount === 1 ? "image was" : "images were";
      return trimmed
        ? `${trimmed}\n\n[${supportedImageCount} Slack ${plural} attached but could not be downloaded for model processing.]`
        : `[${supportedImageCount} Slack ${plural} attached but could not be downloaded for model processing.]`;
    }

    if (images.length > 0) {
      const imageNames = images.map((image) => image.name).filter(Boolean).join(", ");
      const attachmentNote = imageNames
        ? `[Attached Slack image${images.length === 1 ? "" : "s"}: ${imageNames}]`
        : `[Attached ${images.length} Slack image${images.length === 1 ? "" : "s"}.]`;
      return trimmed ? `${trimmed}\n\n${attachmentNote}` : `Please process the attached Slack image${images.length === 1 ? "" : "s"}.\n\n${attachmentNote}`;
    }

    return trimmed;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }
    if (!text?.trim()) return;

    try {
      await this.app.client.chat.postMessage({
        channel: chatId,
        text: text,
      });
    } catch (error) {
      throw new Error(`Slack send failed: ${(error as Error).message}`);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Slack doesn't support typing indicators for bots.
  }

  async setMessageProcessing(chatId: string, messageId: string, processing: boolean): Promise<void> {
    if (this.config.brainReaction !== true) return;

    if (!this.app) {
      throw new Error("Slack not connected");
    }

    const key = `${chatId}:${messageId}`;

    try {
      if (processing) {
        if (this.config.debug) {
          console.log(`[Slack] Adding brain reaction to message ${messageId} in ${chatId}`);
        }
        await this.app.client.reactions.add({
          channel: chatId,
          timestamp: messageId,
          name: "brain",
        });
        this.activeBrainReactions.add(key);
      } else {
        if (!this.activeBrainReactions.has(key)) return;
        if (this.config.debug) {
          console.log(`[Slack] Removing brain reaction from message ${messageId} in ${chatId}`);
        }
        await this.app.client.reactions.remove({
          channel: chatId,
          timestamp: messageId,
          name: "brain",
        });
        this.activeBrainReactions.delete(key);
      }
    } catch (error: any) {
      const slackError = error?.data?.error || error?.message;

      if (processing && slackError === "already_reacted") {
        this.activeBrainReactions.add(key);
        return;
      }

      if (!processing && (slackError === "no_reaction" || slackError === "item_not_found")) {
        this.activeBrainReactions.delete(key);
        return;
      }

      console.warn(
        `[Slack] Failed to ${processing ? "add" : "remove"} brain reaction: ${slackError || error}`
      );
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
