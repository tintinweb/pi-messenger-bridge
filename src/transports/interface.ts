import type { ExternalMessage, SendMessageOptions } from "../types.js";

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
   * @param options - Optional per-message send options (e.g. thread targeting)
   */
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<void>;

  /**
   * Signal that the agent is working on a reply to a chat
   * @param chatId - Chat/channel identifier
   * @param messageId - Identifier of the triggering message, if available
   */
  sendTyping(chatId: string, messageId?: string): Promise<void>;

  /**
   * Clear the "working" signal once a reply has been sent (or the turn errored)
   * @param chatId - Chat/channel identifier
   * @param messageId - Identifier of the triggering message, if available
   */
  clearTyping(chatId: string, messageId?: string): Promise<void>;

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
