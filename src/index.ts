import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { TransportManager } from "./transports/manager.js";
import { TelegramProvider } from "./transports/telegram.js";
import { ChallengeAuth } from "./auth/challenge-auth.js";
import { createStatusWidget } from "./ui/status-widget.js";
import type { PendingRemoteChat, MsgBridgeConfig, TransportStatus } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * pi-remote-pilot extension
 * Bridges messenger apps (Telegram, WhatsApp, Slack, Discord) into pi
 */
export default function (pi: ExtensionAPI): void {
  const transportManager = new TransportManager();
  let pendingRemoteChat: PendingRemoteChat | null = null;
  let auth: ChallengeAuth;
  let ctx: ExtensionContext;

  /**
   * Load config from file or env vars
   */
  function loadConfig(): MsgBridgeConfig {
    const config: MsgBridgeConfig = {};

    // Load config file first
    const configPath = path.join(
      os.homedir(),
      ".pi",
      "msg-bridge",
      "config.json"
    );
    if (fs.existsSync(configPath)) {
      try {
        // Check file permissions (warn if world-readable)
        const stats = fs.statSync(configPath);
        const mode = stats.mode & 0o777;
        if ((mode & 0o077) !== 0) {
          console.warn(`⚠️  Config file ${configPath} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
        }
        
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        Object.assign(config, fileConfig);
      } catch (err) {
        console.error("Failed to load config file:", err);
      }
    }

    // Environment variables override file config (higher priority)
    if (process.env.PI_TELEGRAM_TOKEN) {
      config.telegram = { token: process.env.PI_TELEGRAM_TOKEN };
    }
    if (process.env.PI_WHATSAPP_TOKEN) {
      config.whatsapp = { token: process.env.PI_WHATSAPP_TOKEN };
    }
    if (process.env.PI_SLACK_BOT_TOKEN && process.env.PI_SLACK_APP_TOKEN) {
      config.slack = {
        botToken: process.env.PI_SLACK_BOT_TOKEN,
        appToken: process.env.PI_SLACK_APP_TOKEN,
      };
    }
    if (process.env.PI_DISCORD_TOKEN) {
      config.discord = { token: process.env.PI_DISCORD_TOKEN };
    }

    return config;
  }

  /**
   * Save config to file
   */
  function saveConfig(config: MsgBridgeConfig): void {
    const configDir = path.join(os.homedir(), ".pi", "msg-bridge");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const configPath = path.join(configDir, "config.json");
    // Write with secure permissions (owner read/write only)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  /**
   * Extract text from assistant message
   */
  function extractTextFromMessage(message: AssistantMessage): string {
    const textParts = message.content.filter((part) => part.type === "text");
    return textParts.map((part: any) => part.text).join("\n");
  }

  /**
   * Check if assistant message contains tool calls (more turns will follow)
   */
  function hasToolCalls(message: AssistantMessage): boolean {
    return message.content.some((part) => part.type === "toolCall");
  }

  /**
   * Format tool call summaries for the remote user
   */
  function formatToolCalls(message: AssistantMessage): string {
    const toolCalls = message.content.filter((part) => part.type === "toolCall");
    if (toolCalls.length === 0) return "";
    return toolCalls
      .map((tc: any) => {
        const name = tc.name || "tool";
        const args = tc.arguments || {};
        
        // Format arguments as key=value pairs
        const argPairs = Object.entries(args)
          .map(([k, v]) => {
            const valStr = typeof v === 'string' ? v : JSON.stringify(v);
            return `${k}=${truncate(valStr, 50)}`;
          })
          .join(", ");
        
        return argPairs ? `🔧 ${name} (${argPairs})` : `🔧 ${name}`;
      })
      .join("\n");
  }

  /**
   * Truncate string to max length with ellipsis
   */
  function truncate(str: string, maxLen: number): string {
    if (!str) return "";
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + "...";
  }

  /**
   * Split long messages into chunks, breaking at newlines when possible
   */
  function splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point (newline near the limit)
      let breakAt = remaining.lastIndexOf("\n", maxLen);
      if (breakAt < maxLen * 0.5) {
        // No good newline break, try space
        breakAt = remaining.lastIndexOf(" ", maxLen);
      }
      if (breakAt < maxLen * 0.3) {
        // No good break point, hard cut
        breakAt = maxLen;
      }

      chunks.push(remaining.substring(0, breakAt));
      remaining = remaining.substring(breakAt).trimStart();
    }

    return chunks;
  }

  /**
   * Update status widget
   */
  function updateWidget(): void {
    const config = loadConfig();
    
    // Check if widget should be shown (default true)
    if (config.showWidget === false) {
      ctx.ui.setWidget("msg-bridge-status", undefined);
      return;
    }
    
    const stats = auth.getStats();
    const transports: TransportStatus[] = transportManager
      .getStatus()
      .map((s) => ({
        type: s.type,
        connected: s.connected,
      }));

    const widget = createStatusWidget(transports, stats.usersByTransport);
    if (widget) {
      ctx.ui.setWidget("msg-bridge-status", [widget]);
    } else {
      ctx.ui.setWidget("msg-bridge-status", undefined);
    }
  }

  /**
   * Save auth state to config
   */
  function saveAuthState(): void {
    const config = loadConfig();
    config.auth = auth.exportConfig();
    saveConfig(config);
  }

  /**
   * Initialize extension
   */
  pi.on("session_start", async (event, context) => {
    ctx = context;

    // Load config first
    const config = loadConfig();

    // Initialize auth with save callback
    auth = new ChallengeAuth(
      (code, username) => {
        // Display challenge code prominently in pi terminal
        ctx.ui.notify(
          `🔐 Challenge code for @${username}: ${code}`,
          "info"
        );
      },
      (message, level) => {
        ctx.ui.notify(message, level);
      },
      async (chatId, message) => {
        // This callback is used to send challenge notifications to users
        // The actual sending is done via the transport's sendMessage in telegram.ts
      },
      saveAuthState
    );

    // Load persisted auth state
    if (config.auth) {
      auth.loadFromConfig(config.auth);
    }

    if (config.telegram?.token) {
      const telegramProvider = new TelegramProvider(config.telegram.token, auth);
      transportManager.addTransport(telegramProvider);
    }

    // Auto-connect if configured and autoConnect is not explicitly set to false
    const transports = transportManager.getAllTransports();
    if (transports.length > 0 && config.autoConnect !== false) {
      try {
        await transportManager.connectAll();
        //ctx.ui.notify(`💬 Connected to ${transports.length} transport${transports.length === 1 ? "" : "s"}`, "info");
      } catch (err) {
        ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
      }
    }

    // Handle incoming messages from transports
    transportManager.onMessage((msg) => {
      // Set pending chat context
      pendingRemoteChat = {
        chatId: msg.chatId,
        transport: msg.transport,
        username: msg.username,
        messageId: msg.messageId,
      };

      // Inject message into pi as a user message (triggers agent turn)
      const taggedMessage = `[📱 @${msg.username} via ${msg.transport}]: ${msg.content}`;
      pi.sendUserMessage(taggedMessage);
    });

    // Handle transport errors
    transportManager.onError((err, transport) => {
      ctx.ui.notify(`❌ ${transport} error: ${err.message}`, "error");
    });

    updateWidget();
  });

  /**
   * Handle turn start - send typing indicator
   */
  pi.on("turn_start", async (event, context) => {
    if (pendingRemoteChat) {
      try {
        await transportManager.sendTyping(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport
        );
      } catch (err) {
        // Ignore typing indicator errors
      }
    }
  });

  /**
   * Handle turn end - send response back to messenger
   */
  pi.on("turn_end", async (event, context) => {
    if (!pendingRemoteChat) return;

    try {
      const message = event.message as AssistantMessage;
      const responseText = extractTextFromMessage(message);
      const toolCallsText = formatToolCalls(message);
      const hasPendingTools = hasToolCalls(message);

      // Build full reply: text + tool call indicators
      const parts: string[] = [];
      if (responseText) parts.push(responseText);
      if (toolCallsText) parts.push(toolCallsText);

      // Nothing to send at all — skip
      if (parts.length === 0) return;

      const fullText = parts.join("\n\n");

      // Split long messages for Telegram's 4096 char limit
      const chunks = splitMessage(fullText, 4000);
      for (const chunk of chunks) {
        await transportManager.sendMessage(
          pendingRemoteChat.chatId,
          pendingRemoteChat.transport,
          chunk
        );
      }

      // Only clear pending chat on final turn (no more tool calls pending)
      if (!hasPendingTools) {
        pendingRemoteChat = null;
      }
    } catch (err) {
      const transport = pendingRemoteChat?.transport ?? "unknown";
      ctx.ui.notify(
        `Failed to send response to ${transport}: ${(err as Error).message}`,
        "error"
      );
      pendingRemoteChat = null;
    }
  });

  /**
   * /msg-bridge command - show status or manage connections
   */
  pi.registerCommand("msg-bridge", {
    description: "Manage remote messenger connections (help|status|connect|disconnect|configure|widget)",
    handler: async (args: string, context) => {
      // pi already strips the command name, just parse the args directly
      const parts = args.trim().split(/\s+/).filter(p => p.length > 0);
      const subcommand = parts[0] || "help";

    switch (subcommand) {
      case "help":
        const helpText = [
          "━━━ Message Bridge Commands ━━━",
          "",
          "/msg-bridge help              Show this help",
          "/msg-bridge status            Show connection and user status",
          "/msg-bridge connect           Connect to all transports",
          "/msg-bridge disconnect        Disconnect from all transports",
          "/msg-bridge configure <platform> <token>",
          "                              Configure a transport",
          "/msg-bridge widget            Toggle status widget on/off",
          "",
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        ];
        context.ui.notify(helpText.join("\n"), "info");
        break;
      case "connect":
        try {
          await transportManager.connectAll();
          // Save autoConnect preference
          const cfg = loadConfig();
          cfg.autoConnect = true;
          saveConfig(cfg);
          context.ui.notify("✅ Connected to all configured transports", "info");
          updateWidget();
        } catch (err) {
          context.ui.notify(
            `❌ Connection failed: ${(err as Error).message}`,
            "error"
          );
        }
        break;

      case "disconnect":
        await transportManager.disconnectAll();
        // Save autoConnect preference
        const cfg = loadConfig();
        cfg.autoConnect = false;
        saveConfig(cfg);
        context.ui.notify("🔌 Disconnected from all transports", "info");
        updateWidget();
        break;

      case "configure":
        const platform = parts[1];
        // Join remaining parts in case token has spaces or was split
        const token = parts.slice(2).join(" ");

        if (!platform || !token) {
          context.ui.notify("Usage: /msg-bridge configure <platform> <token>", "error");
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "telegram":
            config.telegram = { token };
            saveConfig(config);
            const telegramProvider = new TelegramProvider(token, auth);
            transportManager.addTransport(telegramProvider);
            try {
              await telegramProvider.connect();
              context.ui.notify("✅ Telegram configured and connected", "info");
            } catch (err) {
              context.ui.notify(`✅ Telegram configured (run /msg-bridge connect to activate)`, "info");
            }
            updateWidget();
            break;

          default:
            context.ui.notify(`❌ Unknown platform: ${platform}`, "error");
        }
        break;

      case "widget":
        const cfg2 = loadConfig();
        cfg2.showWidget = cfg2.showWidget === false ? true : false;
        saveConfig(cfg2);
        const widgetState = cfg2.showWidget !== false ? "shown" : "hidden";
        context.ui.notify(`📊 Status widget ${widgetState}`, "info");
        updateWidget();
        break;

      case "status":
      default:
        const stats = auth.getStats();
        const status = transportManager.getStatus();
        const lines = [
          "━━━ Message Bridge Status ━━━",
          "",
          "Transports:",
          ...status.map(
            (s) => `  ${s.connected ? "🟢" : "🔴"} ${s.type}`
          ),
          "",
          `Trusted Users: ${stats.trustedUsers}`,
        ];
        
        // Add per-transport user lists
        if (stats.trustedUsers > 0) {
          for (const [transport, userIds] of Object.entries(stats.usersByTransport)) {
            if (userIds.length > 0) {
              lines.push(`  └─ ${transport}: ${userIds.join(", ")}`);
            }
          }
        }
        
        lines.push("");
        lines.push(`Channels: ${stats.channels}`);
        lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        
        context.ui.notify(lines.join("\n"), "info");
        break;
    }
    },
  });
}
