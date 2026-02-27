import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
} from "matrix-bot-sdk";
import type { ITransportProvider } from "./interface.js";
import type { ExternalMessage } from "../types.js";
import type { ChallengeAuth } from "../auth/challenge-auth.js";
import {
  formatForMatrix,
  escapeHtml,
  shouldSkipEvent,
  extractUsername,
  wasBotMentioned,
  stripBotMention,
} from "./matrix-utils.js";
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
  private botUserId?: string;
  private joinedRooms = new Set<string>();
  private roomMemberCount = new Map<string, number>();
  private connectedAt = 0;

  constructor(
    private config: { homeserverUrl: string; accessToken: string; encryption?: boolean },
    private auth: ChallengeAuth
  ) {}

  get isConnected(): boolean {
    return this._isConnected;
  }

  // Formatting delegated to matrix-utils.ts (pure, testable)

  async connect(): Promise<void> {
    if (this._isConnected) return;

    const { homeserverUrl, accessToken } = this.config;

    if (!homeserverUrl || !accessToken) {
      throw new Error("Matrix homeserver URL and access token required");
    }

    const storagePath = path.join(
      os.homedir(),
      ".pi",
      "msg-bridge-matrix-store.json"
    );
    const storage = new SimpleFsStorageProvider(storagePath);

    // Set up E2EE crypto storage if encryption is enabled.
    // Uses @matrix-org/matrix-sdk-crypto-nodejs (native Rust, SQLite on disk).
    // Crypto state persists across restarts — same device, same keys.
    // The device must be verified once from another Matrix client (Element, etc).
    let cryptoProvider: RustSdkCryptoStorageProvider | undefined;
    if (this.config.encryption !== false) {
      try {
        const cryptoStorePath = path.join(
          os.homedir(),
          ".pi",
          "msg-bridge-matrix-crypto"
        );
        cryptoProvider = new RustSdkCryptoStorageProvider(cryptoStorePath, RustSdkCryptoStoreType.Sqlite);
        console.log("[Matrix] E2EE crypto storage enabled (Rust/SQLite)");
      } catch (err) {
        console.warn("[Matrix] E2EE crypto not available, continuing without encryption:", (err as Error).message);
      }
    }

    this.client = new MatrixClient(
      homeserverUrl,
      accessToken,
      storage,
      cryptoProvider
    );

    // Auto-join rooms the bot is invited to
    AutojoinRoomsMixin.setupOnClient(this.client);

    // Cache bot user ID (never changes)
    this.botUserId = await this.client.getUserId();

    // Track room membership and member counts
    this.client.on("room.join", (roomId: string) => {
      this.joinedRooms.add(roomId);
      // Refresh member count asynchronously
      this.client?.getJoinedRoomMembers(roomId)
        .then(members => this.roomMemberCount.set(roomId, members.length))
        .catch(() => {});
    });
    this.client.on("room.leave", (roomId: string) => {
      this.joinedRooms.delete(roomId);
      this.roomMemberCount.delete(roomId);
    });

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

    try {
      await this.client.start();
    } catch (error) {
      // Clean up dangling state so connect() can be retried
      this.client = undefined;
      this.botUserId = undefined;
      this.joinedRooms.clear();
      this.roomMemberCount.clear();
      console.error("[Matrix] Failed to connect:", error);
      throw error;
    }

    // Seed joined rooms and member count caches
    const rooms = await this.client.getJoinedRooms();
    this.joinedRooms = new Set(rooms);
    await Promise.all(rooms.map(async (roomId) => {
      try {
        const members = await this.client!.getJoinedRoomMembers(roomId);
        this.roomMemberCount.set(roomId, members.length);
      } catch {
        // Will be fetched on first message if needed
      }
    }));
    this.connectedAt = Date.now();
    this._isConnected = true;
    const cryptoStatus = cryptoProvider ? "E2EE enabled" : "E2EE disabled";
    console.log(`✅ Matrix connected as ${this.botUserId} (${rooms.length} rooms, ${cryptoStatus})`);
  }

  async disconnect(): Promise<void> {
    if (!this._isConnected || !this.client) return;

    this.client.stop();
    this._isConnected = false;
    this.client = undefined;
    this.botUserId = undefined;
    this.joinedRooms.clear();
    this.roomMemberCount.clear();
    this.connectedAt = 0;
    console.log("[Matrix] Disconnected");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error("Matrix client not connected");
    }

    const { body, formattedBody } = formatForMatrix(text);

    await this.client.sendMessage(chatId, {
      msgtype: "m.text",
      body,
      ...(formattedBody && {
        format: "org.matrix.custom.html",
        formatted_body: formattedBody,
      }),
    });
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
    if (!this.client || !this.botUserId) return;

    // Pure filter — delegates to testable utility
    const skipReason = shouldSkipEvent(event, this.botUserId, this.connectedAt, this.joinedRooms, roomId);
    if (skipReason) return;

    const chatId = roomId;
    const userId = event.sender; // e.g. @user:matrix.org
    const username = extractUsername(userId);
    const messageText = event.content.body;
    const messageId = event.event_id;

    // Determine if group chat from cached member count (no API call per message)
    let memberCount = this.roomMemberCount.get(roomId);
    if (memberCount === undefined) {
      // Cache miss — fetch once and cache
      try {
        const members = await this.client.getJoinedRoomMembers(roomId);
        memberCount = members.length;
        this.roomMemberCount.set(roomId, memberCount);
      } catch {
        memberCount = 2; // Default to DM if we can't check
      }
    }
    const isGroupChat = memberCount > 2;

    // Check if bot was mentioned (pure utility)
    const wasMentioned = isGroupChat ? wasBotMentioned(messageText, this.botUserId) : false;

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

    // Strip bot mention from message (pure utility)
    const cleanContent = wasMentioned && this.botUserId
      ? stripBotMention(messageText, this.botUserId)
      : messageText;

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
