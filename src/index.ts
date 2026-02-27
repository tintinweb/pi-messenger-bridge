import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { TransportManager } from "./transports/manager.js";
import { TelegramProvider } from "./transports/telegram.js";
import { WhatsAppProvider } from "./transports/whatsapp.js";
import { SlackProvider } from "./transports/slack.js";
import { DiscordProvider } from "./transports/discord.js";
import { MatrixProvider } from "./transports/matrix.js";
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
      "msg-bridge.json"
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
    if (process.env.PI_WHATSAPP_AUTH_PATH) {
      config.whatsapp = { authPath: process.env.PI_WHATSAPP_AUTH_PATH };
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
    if (process.env.PI_MATRIX_HOMESERVER && process.env.PI_MATRIX_ACCESS_TOKEN) {
      config.matrix = {
        homeserverUrl: process.env.PI_MATRIX_HOMESERVER,
        accessToken: process.env.PI_MATRIX_ACCESS_TOKEN,
      };
    }

    return config;
  }

  /**
   * Save config to file
   */
  function saveConfig(config: MsgBridgeConfig): void {
    const configDir = path.join(os.homedir(), ".pi");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    }
    const configPath = path.join(configDir, "msg-bridge.json");
    // Write with secure permissions (owner read/write only)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    // Ensure directory permissions are also secure
    try {
      fs.chmodSync(configDir, 0o700);
    } catch (err) {
      console.warn("Failed to set directory permissions:", err);
    }
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

    // Initialize transports in the background (non-blocking)
    (async () => {
      const transportPromises: Promise<void>[] = [];

      if (config.telegram?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const telegramProvider = new TelegramProvider(config.telegram!.token, auth);
            transportManager.addTransport(telegramProvider);
          })
        );
      }

      // Only auto-add WhatsApp if it has existing session (already authenticated)
      if (config.whatsapp) {
        const whatsappAuthPath = config.whatsapp.authPath || path.join(
          os.homedir(),
          ".pi",
          "msg-bridge-whatsapp-auth"
        );
        
        // Check if WhatsApp session exists (creds.json file present)
        const credsPath = path.join(whatsappAuthPath, "creds.json");
        if (fs.existsSync(credsPath)) {
          transportPromises.push(
            Promise.resolve().then(() => {
              const whatsappConfig = { ...config.whatsapp!, debug: config.debug };
              const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
              transportManager.addTransport(whatsappProvider);
            })
          );
        } else {
          // No valid credentials - remove from config
          delete config.whatsapp;
          saveConfig(config);
        }
      }

      // Auto-add Slack if configured
      if (config.slack?.botToken && config.slack?.appToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const slackProvider = new SlackProvider(config.slack!, auth);
            transportManager.addTransport(slackProvider);
          })
        );
      }

      // Auto-add Discord if configured
      if (config.discord?.token) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const discordProvider = new DiscordProvider(config.discord!, auth);
            transportManager.addTransport(discordProvider);
          })
        );
      }

      // Auto-add Matrix if configured
      if (config.matrix?.homeserverUrl && config.matrix?.accessToken) {
        transportPromises.push(
          Promise.resolve().then(() => {
            const matrixProvider = new MatrixProvider(
              config.matrix!.homeserverUrl,
              config.matrix!.accessToken,
              auth
            );
            transportManager.addTransport(matrixProvider);
          })
        );
      }

      // Wait for all transports to be initialized
      await Promise.all(transportPromises);

      // Auto-connect if configured and autoConnect is not explicitly set to false
      const transports = transportManager.getAllTransports();
      if (transports.length > 0 && config.autoConnect !== false) {
        try {
          await transportManager.connectAll();
          updateWidget();
        } catch (err) {
          ctx.ui.notify(`⚠️ Some transports failed to connect: ${(err as Error).message}`, "warning");
        }
      }
    })().catch(err => {
      console.error("Transport initialization error:", err);
      ctx.ui.notify(`❌ Transport initialization failed: ${err.message}`, "error");
    });

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
          "/msg-bridge configure telegram <token>",
          "                              Configure Telegram bot",
          "/msg-bridge configure whatsapp",
          "                              Configure WhatsApp (scan QR)",
          "/msg-bridge configure matrix <homeserver-url> <access-token>",
          "                              Configure Matrix (Element X, etc)",
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

        if (!platform) {
          context.ui.notify("Usage: /msg-bridge configure <platform> [token/path]", "error");
          return;
        }

        const config = loadConfig();

        switch (platform.toLowerCase()) {
          case "telegram":
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure telegram <bot-token>", "error");
              return;
            }
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

          case "whatsapp":
            // Token is optional (defaults to ~/.pi/msg-bridge/whatsapp-auth)
            config.whatsapp = token ? { authPath: token } : {};
            saveConfig(config);
            const whatsappConfig = { ...config.whatsapp, debug: config.debug };
            const whatsappProvider = new WhatsAppProvider(whatsappConfig, auth);
            transportManager.addTransport(whatsappProvider);
            try {
              await whatsappProvider.connect(true); // manual = true for configure command
              context.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
            } catch (err) {
              context.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
            }
            updateWidget();
            break;

          case "slack":
            // Slack requires both bot token and app token
            const parts2 = token.split(/\s+/);
            const botToken = parts2[0];
            const appToken = parts2[1];
            
            if (!botToken || !appToken) {
              context.ui.notify("Usage: /msg-bridge configure slack <bot-token> <app-token>", "error");
              return;
            }
            
            config.slack = { botToken, appToken };
            saveConfig(config);
            const slackProvider = new SlackProvider(config.slack, auth);
            transportManager.addTransport(slackProvider);
            try {
              await slackProvider.connect();
              context.ui.notify("✅ Slack configured and connected", "info");
            } catch (err) {
              context.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
            }
            updateWidget();
            break;

          case "discord":
            if (!token) {
              context.ui.notify("Usage: /msg-bridge configure discord <bot-token>", "error");
              return;
            }
            
            config.discord = { token };
            saveConfig(config);
            const discordProvider = new DiscordProvider(config.discord, auth);
            transportManager.addTransport(discordProvider);
            try {
              await discordProvider.connect();
              context.ui.notify("✅ Discord configured and connected", "info");
            } catch (err) {
              context.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
            }
            updateWidget();
            break;

          case "matrix": {
            // Expect: /msg-bridge configure matrix <homeserver-url> <access-token>
            const matrixParts = token.split(/\s+/);
            const homeserverUrl = matrixParts[0];
            const matrixAccessToken = matrixParts.slice(1).join(" ");

            if (!homeserverUrl || !matrixAccessToken) {
              context.ui.notify("Usage: /msg-bridge configure matrix <homeserver-url> <access-token>", "error");
              return;
            }

            config.matrix = { homeserverUrl, accessToken: matrixAccessToken };
            saveConfig(config);
            const matrixProvider = new MatrixProvider(homeserverUrl, matrixAccessToken, auth);
            transportManager.addTransport(matrixProvider);
            try {
              await matrixProvider.connect();
              context.ui.notify("✅ Matrix configured and connected", "info");
            } catch (err) {
              context.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
            }
            updateWidget();
            break;
          }

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
