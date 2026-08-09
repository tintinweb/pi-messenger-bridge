import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import type { ExternalMessage, SendMessageOptions } from "../types.js";
import type { ITransportProvider } from "./interface.js";
import { formatForSlack } from "./slack-utils.js";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB
const UPLOADS_DIR = path.join(os.homedir(), ".pi", "msg-bridge-uploads");

/** Strip anything but a conservative filename character set. */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
}

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

    // Listen for all messages
    this.app.message(async ({ message, client }: any) => {
      // Skip bot messages, edits, deletes, etc. — but allow file uploads (subtype "file_share") through.
      if (message.subtype && message.subtype !== "file_share") {
        return;
      }

      const files: any[] = Array.isArray(message.files) ? message.files : [];

      // TypeScript type guard for regular messages
      if (!("user" in message) || (!message.text && files.length === 0)) {
        return;
      }

      const userId = message.user;
      const channelId = message.channel;
      const text = message.text || "";
      const ts = message.ts;
      const threadTs = message.thread_ts;

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

      // Save any attachments to disk (any file type) and note their local path so the
      // agent can inspect them with its own read/bash tools.
      const fileNotes: string[] = [];
      for (const file of files) {
        const savedPath = await this.downloadAndSaveFile(file);
        if (savedPath) {
          const sizeKb = typeof file.size === "number" ? `${Math.round(file.size / 1024)}KB` : "unknown size";
          fileNotes.push(
            `[User attached a file, saved to ${savedPath} (name: ${file.name || "unnamed"}, type: ${file.mimetype || file.filetype || "unknown"}, ${sizeKb})]`
          );
        } else {
          fileNotes.push(`[Attached file "${file.name || "unnamed"}" could not be downloaded]`);
        }
      }
      const content = [text.trim(), ...fileNotes].filter(Boolean).join("\n");

      // Forward to message handler
      if (this.messageHandler) {
        const externalMessage: ExternalMessage = {
          chatId: channelId,
          transport: this.type,
          content,
          username: username,
          userId: userId,
          timestamp: new Date(parseFloat(ts) * 1000),
          messageId: ts,
          isGroupChat,
          wasMentioned,
          threadTs,
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
    console.log("[Slack] Disconnected");
  }

  /**
   * Download a Slack file attachment (any type) and save it to disk, capped at MAX_UPLOAD_BYTES.
   * Returns the saved absolute path, or null on failure.
   */
  private async downloadAndSaveFile(file: any): Promise<string | null> {
    if (!file.url_private || (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES)) {
      return null;
    }
    try {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${this.config.botToken}` },
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_UPLOAD_BYTES) return null;

      fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
      const uniquePrefix = crypto.randomBytes(4).toString("hex");
      const filename = `${file.id || uniquePrefix}-${sanitizeFilename(file.name || "file")}`;
      const savedPath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(savedPath, buf, { mode: 0o600 });
      return savedPath;
    } catch {
      return null;
    }
  }

  async sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }
    if (!text?.trim()) return;

    try {
      await this.app.client.chat.postMessage({
        channel: chatId,
        text: formatForSlack(text),
        thread_ts: options?.threadTs,
      });
    } catch (error) {
      throw new Error(`Slack send failed: ${(error as Error).message}`);
    }
  }

  /** Upload an existing local file to a Slack chat, e.g. from the slack_upload_file tool. */
  async uploadFile(
    chatId: string,
    filePath: string,
    options?: { comment?: string; threadTs?: string }
  ): Promise<void> {
    if (!this.app) {
      throw new Error("Slack not connected");
    }

    try {
      const buf = fs.readFileSync(filePath);
      await this.app.client.files.uploadV2({
        channel_id: chatId,
        thread_ts: options?.threadTs,
        file: buf,
        filename: path.basename(filePath),
        initial_comment: options?.comment,
      });
    } catch (error) {
      throw new Error(`Slack file upload failed: ${(error as Error).message}`);
    }
  }

  // Slack has no bot "typing..." indicator, so we signal work-in-progress via a reaction
  // on the triggering message instead.
  private static readonly WORKING_REACTION = "hourglass_flowing_sand";

  async sendTyping(chatId: string, messageId?: string): Promise<void> {
    if (!this.app || !messageId) return;
    try {
      await this.app.client.reactions.add({
        channel: chatId,
        timestamp: messageId,
        name: SlackProvider.WORKING_REACTION,
      });
    } catch {
      // Ignore — e.g. already reacted, message deleted, missing scope
    }
  }

  async clearTyping(chatId: string, messageId?: string): Promise<void> {
    if (!this.app || !messageId) return;
    try {
      await this.app.client.reactions.remove({
        channel: chatId,
        timestamp: messageId,
        name: SlackProvider.WORKING_REACTION,
      });
    } catch {
      // Ignore — e.g. reaction already gone, message deleted
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }
}
