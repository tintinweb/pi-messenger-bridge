import type { ExternalMessage } from "../types.js";

/**
 * Transport provider interface
 * Adapts different messenger platforms (Telegram, WhatsApp, Slack, Discord)
 */
export interface ITransportProvider {
  /** Transport type identifier */
  readonly type: string;

  /** Is the transport currently connected? */
  readonly isConnected: boolean;

  /**
   * Connect to the messenger service
   * @throws Error if connection fails
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the messenger service
   */
  disconnect(): Promise<void>;

  /**
   * Send a text message to a chat
   * @param chatId - Chat/channel identifier
   * @param text - Message content
   */
  sendMessage(chatId: string, text: string): Promise<void>;

  /**
   * Send typing indicator to a chat
   * @param chatId - Chat/channel identifier
   */
  sendTyping(chatId: string): Promise<void>;

  /**
   * Register callback for incoming messages
   * @param handler - Message handler function
   */
  onMessage(handler: (message: ExternalMessage) => void): void;

  /**
   * Register callback for errors
   * @param handler - Error handler function
   */
  onError(handler: (error: Error) => void): void;
}
