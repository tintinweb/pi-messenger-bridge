/**
 * External message received from a messenger transport
 */
export interface ExternalMessage {
  /** Unique chat/channel identifier */
  chatId: string;
  /** Transport type (telegram, whatsapp, etc) */
  transport: string;
  /** Message content/text */
  content: string;
  /** Sender username */
  username: string;
  /** Sender user ID */
  userId: string;
  /** Message timestamp */
  timestamp: Date;
  /** Unique message identifier */
  messageId: string;
  /** Is this a group/channel message? */
  isGroupChat: boolean;
  /** Was the bot mentioned? (for group chats) */
  wasMentioned?: boolean;
  /** Thread identifier, if this message was itself sent inside a thread (Slack only) */
  threadTs?: string;
}

/**
 * Configuration for msg-bridge extension
 */
export interface MsgBridgeConfig {
  telegram?: {
    token: string;
  };
  whatsapp?: {
    authPath?: string;
  };
  slack?: {
    botToken: string;
    appToken: string;
  };
  discord?: {
    token: string;
  };
  matrix?: {
    homeserverUrl: string;
    accessToken: string;
    encryption?: boolean;
  };
  auth?: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  };
  hideToolCalls?: boolean;
  autoConnect?: boolean;
  showWidget?: boolean;
  debug?: boolean;
  /** Reply in-thread when the inbound Slack message was itself in a thread. Default: on (undefined = true). */
  slackMirrorThreads?: boolean;
}

/**
 * Pending remote chat session tracking
 */
export interface PendingRemoteChat {
  chatId: string;
  transport: string;
  username: string;
  messageId: string;
  threadTs?: string;
}

/**
 * Optional per-message send options
 */
export interface SendMessageOptions {
  /** Reply within this thread (Slack only; ignored by other transports) */
  threadTs?: string;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
