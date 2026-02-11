/**
 * Challenge-based authentication for remote messengers
 * Ported from vscode-chonky-remote-pilot
 */

interface ChallengeData {
  code: string;
  userId: string;
  chatId: string;
  username: string;
  expiresAt: number;
  attempts: number;
}

interface ChannelAuth {
  enabled: boolean;
  mode: "all" | "mentions" | "trusted-only";
}

/**
 * Manages authentication via 6-digit challenge codes and trusted users
 */
export class ChallengeAuth {
  private challenges = new Map<string, ChallengeData>();
  private trustedUsers = new Set<string>();
  private channelAuth = new Map<string, ChannelAuth>();
  private blockedUsers = new Map<string, number>(); // userId -> unblock timestamp
  private adminUserId?: string;

  constructor(
    private onShowCode: (code: string, username: string) => void,
    private onNotify: (message: string, level?: "info" | "warning" | "error") => void,
    private onSendMessage?: (chatId: string, message: string) => Promise<void>,
    private onSaveAuth?: () => void
  ) {}

  /**
   * Initialize auth state from config
   */
  loadFromConfig(config: {
    trustedUsers?: string[];
    adminUserId?: string;
    channels?: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  }): void {
    if (config.trustedUsers) {
      this.trustedUsers = new Set(config.trustedUsers);
    }
    if (config.adminUserId) {
      this.adminUserId = config.adminUserId;
    }
    if (config.channels) {
      this.channelAuth = new Map(Object.entries(config.channels));
    }
  }

  /**
   * Export auth state for config persistence
   */
  exportConfig(): {
    trustedUsers: string[];
    adminUserId?: string;
    channels: Record<string, { enabled: boolean; mode: "all" | "mentions" | "trusted-only" }>;
  } {
    return {
      trustedUsers: Array.from(this.trustedUsers),
      adminUserId: this.adminUserId,
      channels: Object.fromEntries(this.channelAuth),
    };
  }

  /**
   * Check if a user is authorized to send messages
   * Handles challenge creation, validation, and channel authorization
   */
  async checkAuthorization(
    userId: string,
    chatId: string,
    username: string,
    isGroupChat: boolean,
    wasMentioned: boolean,
    sendMessage?: (chatId: string, message: string) => Promise<void>,
    transport?: string
  ): Promise<boolean> {
    // Create namespaced user ID (transport:userId)
    const namespacedUserId = transport ? `${transport}:${userId}` : userId;
    
    // Check if user is blocked
    const blockedUntil = this.blockedUsers.get(namespacedUserId);
    if (blockedUntil && Date.now() < blockedUntil) {
      return false;
    }
    if (blockedUntil && Date.now() >= blockedUntil) {
      this.blockedUsers.delete(namespacedUserId);
    }

    // DM: check trusted or initiate challenge
    if (!isGroupChat) {
      if (this.trustedUsers.has(namespacedUserId)) {
        // Set as admin if first trusted user
        if (!this.adminUserId) {
          this.adminUserId = namespacedUserId;
          this.onNotify(`🔐 ${username} is now the admin`, "info");
        }
        return true;
      }

      // Temporarily override onSendMessage for this challenge if provided
      if (sendMessage) {
        const originalSender = this.onSendMessage;
        this.onSendMessage = sendMessage;
        const result = await this.initiateChallenge(namespacedUserId, chatId, username);
        this.onSendMessage = originalSender;
        return result;
      }
      
      return await this.initiateChallenge(namespacedUserId, chatId, username);
    }

    // Group chat: check channel authorization
    const channelAuthData = this.channelAuth.get(chatId);

    // Channel not enabled
    if (!channelAuthData || !channelAuthData.enabled) {
      return false;
    }

    // Check mode
    switch (channelAuthData.mode) {
      case "all":
        return true;
      case "mentions":
        return wasMentioned || false;
      case "trusted-only":
        return this.trustedUsers.has(namespacedUserId);
      default:
        return false;
    }
  }

  /**
   * Initiate or validate a challenge
   */
  private async initiateChallenge(
    userId: string,
    chatId: string,
    username: string
  ): Promise<boolean> {
    const existingChallenge = this.challenges.get(userId);

    // Check if there's an active challenge
    if (existingChallenge) {
      // Expired?
      if (Date.now() > existingChallenge.expiresAt) {
        this.challenges.delete(userId);
        return await this.initiateChallenge(userId, chatId, username);
      }

      // Challenge still active, return false (user needs to enter code)
      return false;
    }

    // Create new challenge
    const code = this.generateCode();
    const expiresAt = Date.now() + 2 * 60 * 1000; // 2 minutes

    this.challenges.set(userId, {
      code,
      userId,
      chatId,
      username,
      expiresAt,
      attempts: 0,
    });

    // Show code in terminal FIRST
    this.onShowCode(code, username);
    
    // Then send message to user asking for the code
    if (this.onSendMessage) {
      try {
        await this.onSendMessage(
          chatId,
          "🔐 Please enter the 6-digit code provided by the bot admin.\n⏱️ Expires in 2 minutes."
        );
      } catch (err) {
        // Ignore send errors
      }
    }
    
    return false;
  }

  /**
   * Handle admin commands in DM
   * Returns true if command was handled
   */
  async handleAdminCommand(
    text: string,
    chatId: string,
    userId: string,
    sendMessage: (text: string) => Promise<void>,
    transport?: string
  ): Promise<boolean> {
    // Create namespaced user ID
    const namespacedUserId = transport ? `${transport}:${userId}` : userId;
    
    // Non-admin users: check for challenge code entry
    if (!this.trustedUsers.has(namespacedUserId)) {
      const challenge = this.challenges.get(namespacedUserId);
      if (challenge && text.match(/^\d{6}$/)) {
        return await this.validateChallenge(namespacedUserId, text, sendMessage);
      }
      return false;
    }

    // Admin commands
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case "/help":
        await sendMessage(this.getHelpText());
        return true;

      case "/enable":
        if (parts.length < 3) {
          await sendMessage("Usage: /enable <chatId> <all|mentions|trusted-only>");
          return true;
        }
        this.channelAuth.set(parts[1], {
          enabled: true,
          mode: parts[2] as any,
        });
        if (this.onSaveAuth) this.onSaveAuth();
        await sendMessage(`✅ Channel ${parts[1]} enabled (mode: ${parts[2]})`);
        this.onNotify(`Channel ${parts[1]} enabled (${parts[2]})`, "info");
        return true;

      case "/disable":
        if (parts.length < 2) {
          await sendMessage("Usage: /disable <chatId>");
          return true;
        }
        this.channelAuth.delete(parts[1]);
        if (this.onSaveAuth) this.onSaveAuth();
        await sendMessage(`❌ Channel ${parts[1]} disabled`);
        this.onNotify(`Channel ${parts[1]} disabled`, "info");
        return true;

      case "/channels":
        const channels = Array.from(this.channelAuth.entries())
          .map(([id, auth]) => `• ${id}: ${auth.enabled ? "✅" : "❌"} (${auth.mode})`)
          .join("\n");
        await sendMessage(channels || "No channels configured");
        return true;

      case "/trusted":
        const trusted = Array.from(this.trustedUsers)
          .map(id => {
            const [transport, uid] = id.split(':');
            return uid ? `${uid} (${transport})` : id;
          })
          .join(", ");
        await sendMessage(`Trusted users (${this.trustedUsers.size}):\n${trusted || "None"}`);
        return true;

      case "/revoke":
        if (parts.length < 2) {
          await sendMessage("Usage: /revoke <userId> or /revoke <transport:userId>");
          return true;
        }
        const revokeId = parts[1];
        // Support both "telegram:123" and "123" (searches for any match)
        let revoked = false;
        if (revokeId.includes(':')) {
          // Full namespaced ID
          if (this.trustedUsers.has(revokeId)) {
            this.trustedUsers.delete(revokeId);
            revoked = true;
          }
        } else {
          // Plain ID - search across all transports
          for (const id of this.trustedUsers) {
            if (id.endsWith(`:${revokeId}`)) {
              this.trustedUsers.delete(id);
              revoked = true;
              break;
            }
          }
        }
        if (revoked) {
          if (this.onSaveAuth) this.onSaveAuth();
          await sendMessage(`🔓 Revoked trust for ${revokeId}`);
          this.onNotify(`Revoked: ${revokeId}`, "warning");
        } else {
          await sendMessage(`❌ User ${revokeId} not found in trusted users`);
        }
        return true;

      default:
        return false;
    }
  }

  /**
   * Validate a challenge code entered by the user
   */
  private async validateChallenge(
    userId: string,
    code: string,
    sendMessage: (text: string) => Promise<void>
  ): Promise<boolean> {
    const challenge = this.challenges.get(userId);
    if (!challenge) return false;

    // Expired?
    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(userId);
      await sendMessage("⏱️ Challenge expired. Send any message to get a new code.");
      return true;
    }

    // Correct code?
    if (code === challenge.code) {
      this.trustedUsers.add(userId);
      this.challenges.delete(userId);
      if (this.onSaveAuth) this.onSaveAuth();
      await sendMessage("✅ Authenticated! You can now chat with the agent.");
      this.onNotify(`✅ ${challenge.username} authenticated`, "info");
      return true;
    }

    // Wrong code
    challenge.attempts++;
    if (challenge.attempts >= 3) {
      this.challenges.delete(userId);
      this.blockedUsers.set(userId, Date.now() + 5 * 60 * 1000); // 5 min block
      await sendMessage("🚫 Too many failed attempts. Blocked for 5 minutes.");
      this.onNotify(`🚫 ${challenge.username} blocked (3 failed attempts)`, "warning");
      return true;
    }

    await sendMessage(
      `❌ Wrong code. ${3 - challenge.attempts} attempts remaining.`
    );
    return true;
  }

  /**
   * Generate a random 6-digit code
   */
  private generateCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * Get help text for admin commands
   */
  private getHelpText(): string {
    return `**Admin Commands**

*DM Only:*
• \`/help\` — Show this help
• \`/trusted\` — List trusted users
• \`/revoke <userId>\` — Revoke trust for a user
• \`/channels\` — List enabled channels
• \`/enable <chatId> <mode>\` — Enable a channel
  Modes: \`all\`, \`mentions\`, \`trusted-only\`
• \`/disable <chatId>\` — Disable a channel

*Authentication:*
• First DM to bot → 6-digit code shown in terminal
• Enter code in chat → become trusted
• First trusted user = admin`;
  }

  /**
   * Get current stats with detailed user info
   */
  getStats(): { 
    trustedUsers: number; 
    channels: number;
    usersByTransport: Record<string, string[]>;
  } {
    // Group users by transport
    const usersByTransport: Record<string, string[]> = {};
    for (const namespacedId of this.trustedUsers) {
      const [transport, userId] = namespacedId.split(':');
      if (transport && userId) {
        if (!usersByTransport[transport]) {
          usersByTransport[transport] = [];
        }
        usersByTransport[transport].push(userId);
      }
    }
    
    return {
      trustedUsers: this.trustedUsers.size,
      channels: Array.from(this.channelAuth.values()).filter((a) => a.enabled).length,
      usersByTransport,
    };
  }
}
