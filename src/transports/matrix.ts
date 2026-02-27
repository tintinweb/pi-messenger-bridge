import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "matrix-bot-sdk";
import type { ITransportProvider } from "./interface.js";
import type { ExternalMessage } from "../types.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import * as path from "path";
import * as os from "os";

/**
 * Matrix transport provider using matrix-bot-sdk
 * Works with any Matrix homeserver — Element X, Element Web, FluffyChat, etc.
 */
export class MatrixProvider implements ITransportProvider {
  readonly type = "matrix";
  private client?: MatrixClient;
  private _isConnected = false;
  private messageHandler?: (message: ExternalMessage) => void;
  private errorHandler?: (error: Error) => void;

  constructor(
    private homeserverUrl: string,
    private accessToken: string,
    private auth: ChallengeAuth
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Convert standard markdown to Matrix HTML for rich formatting.
   * Matrix supports a subset of HTML in m.formatted_body.
   * For simplicity we send plain text with org.matrix.custom.html format
   * only when there's actual markdown to convert.
   */
  private formatForMatrix(text: string): { body: string; formattedBody?: string } {
    // Always include plain text body
    // Only add formatted_body if there's markdown worth converting
    const hasMarkdown = /[*_`#\[]/.test(text);
    if (!hasMarkdown) {
      return { body: text };
    }

    let html = text;

    // Protect code blocks
    const codeBlocks: string[] = [];
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.trimEnd())}</code></pre>`);
      return `__CODEBLOCK_${codeBlocks.length - 1}__`;
    });

    // Protect inline code
    const inlineCodes: string[] = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
      return `__INLINECODE_${inlineCodes.length - 1}__`;
    });

    // Bold
    html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    // Italic
    html = html.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // Newlines to <br>
    html = html.replace(/\n/g, "<br>");

    // Restore code blocks and inline code
    html = html.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx)]);
    html = html.replace(/__INLINECODE_(\d+)__/g, (_, idx) => inlineCodes[parseInt(idx)]);

    return { body: text, formattedBody: html };
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const storagePath = path.join(
      os.homedir(),
      ".pi",
      "msg-bridge-matrix-store.json"
    );
    const storage = new SimpleFsStorageProvider(storagePath);

    this.client = new MatrixClient(
      this.homeserverUrl,
      this.accessToken,
      storage
    );

    // Auto-join rooms the bot is invited to
    AutojoinRoomsMixin.setupOnClient(this.client);

    // Handle incoming messages
    this.client.on("room.message", async (roomId: string, event: any) => {
      try {
        await this.handleMessage(roomId, event);
      } catch (err) {
        if (this.errorHandler) {
          this.errorHandler(err as Error);
        }
      }
    });

    await this.client.start();
    this._isConnected = true;
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected || !this.client) return;

    this.client.stop();
    this._isConnected = false;
    this.client = undefined;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }

    const { body, formattedBody } = this.formatForMatrix(text);

    if (formattedBody) {
      await this.client.sendMessage(chatId, {
        msgtype: "m.text",
        body,
        format: "org.matrix.custom.html",
        formatted_body: formattedBody,
      });
    } else {
      await this.client.sendMessage(chatId, {
        msgtype: "m.text",
        body,
      });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setTyping(chatId, true, 10000);
    } catch {
      // Ignore typing indicator errors
    }
  }

  onMessage(handler: (message: ExternalMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  private async handleMessage(roomId: string, event: any): Promise<void> {
    // Ignore own messages
    if (!this.client) return;
    const botUserId = await this.client.getUserId();
    if (event.sender === botUserId) return;

    // Only process text messages
    const content = event.content;
    if (!content || content.msgtype !== "m.text" || !content.body) return;

    // Ignore edits (we only process original messages)
    if (content["m.new_content"]) return;

    const chatId = roomId;
    const userId = event.sender; // e.g. @user:matrix.org
    // Extract localpart as username
    const username = userId.replace(/^@/, "").replace(/:.*$/, "");
    const messageText = content.body;
    const messageId = event.event_id;

    // Determine if group chat by checking room member count
    let isGroupChat = false;
    try {
      const members = await this.client.getJoinedRoomMembers(roomId);
      isGroupChat = members.length > 2;
    } catch {
      // Default to false if we can't check
    }

    // Check if bot was mentioned
    let wasMentioned = false;
    if (isGroupChat) {
      wasMentioned =
        messageText.includes(botUserId) ||
        messageText.toLowerCase().includes(botUserId.split(":")[0].substring(1).toLowerCase());
    }

    // Check authorization
    const sendMessageToUser = async (cId: string, text: string) => {
      await this.sendMessage(cId, text);
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

    // Handle challenge codes and commands in DMs
    if (!isGroupChat && (messageText.startsWith("/") || messageText.match(/^\d{6}$/))) {
      const handled = await this.auth.handleAdminCommand(
        messageText,
        chatId,
        userId,
        async (text) => await this.sendMessage(chatId, text),
        this.type
      );
      if (handled) return;
    }

    if (!isAuthorized) return;

    // Strip bot mention from message
    let cleanContent = messageText;
    if (wasMentioned) {
      cleanContent = cleanContent
        .replace(new RegExp(botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "")
        .trim();
    }

    // Forward to message handler
    if (this.messageHandler && cleanContent) {
      const externalMessage: ExternalMessage = {
        chatId,
        transport: this.type,
        content: cleanContent,
        username,
        userId,
        timestamp: new Date(event.origin_server_ts || Date.now()),
        messageId,
        isGroupChat,
        wasMentioned,
      };

      this.messageHandler(externalMessage);
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
