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
    /** Auto-bootstrap cross-signing on connect (mirrors hermes/mautrix MATRIX_RECOVERY_KEY
     *  philosophy). Defaults to true when encryption is on. Set to false to keep the
     *  pre-patch behavior (manual Element-side trust). Set to "reset" to force a fresh
     *  cross-signing identity — invalidates trust from other devices/users. */
    selfCrossSign?: boolean | "reset";
    /** Account password used for UIA on /_matrix/client/v3/keys/upload when the homeserver
     *  requires it for cross-signing key upload. Prefer the env-var equivalent
     *  (PI_MATRIX_ACCOUNT_PASSWORD) or password file (PI_MATRIX_PASSWORD_FILE) to keep the
     *  password out of msg-bridge.json. */
    accountPassword?: string;
    /** SSSS recovery key (base58, as Element generates it during "Set up Secure Backup").
     *  Triggers the import-from-SSSS path instead of the reset path — preferred when
     *  another Element-as-@bot session already established cross-signing. Prefer the
     *  env-var (PI_MATRIX_RECOVERY_KEY) or file (PI_MATRIX_RECOVERY_KEY_FILE) to keep it
     *  out of msg-bridge.json. */
    recoveryKey?: string;
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
}

/**
 * Pending remote chat session tracking
 */
export interface PendingRemoteChat {
  chatId: string;
  transport: string;
  username: string;
  messageId: string;
}

/**
 * Transport connection status
 */
export interface TransportStatus {
  type: string;
  connected: boolean;
  error?: string;
}
