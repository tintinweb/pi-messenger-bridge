/**
 * main-menu.ts — Interactive main menu for /msg-bridge.
 *
 * Shows transport status in the title, with Connect, Configure, Widget, and Help.
 */

import type { ChallengeAuth } from "../auth/challenge-auth.js";
import { loadConfig, saveConfig } from "../config.js";
import { acquireLock, releaseLock } from "../lock.js";
import { DiscordProvider } from "../transports/discord.js";
import type { TransportManager } from "../transports/manager.js";
import { MatrixProvider } from "../transports/matrix.js";
import { SlackProvider } from "../transports/slack.js";
import { TelegramProvider } from "../transports/telegram.js";
import { WhatsAppProvider } from "../transports/whatsapp.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MenuUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
};

export interface MenuContext {
  ui: MenuUI;
  transportManager: TransportManager;
  auth: ChallengeAuth;
  updateWidget: () => void;
}

// ── Status ──────────────────────────────────────────────────────────────────

function getStatusLine(mctx: MenuContext): string {
  const status = mctx.transportManager.getStatus();
  const stats = mctx.auth.getStats();

  if (status.length === 0) {
    return "No transports configured";
  }

  const transportLines = status
    .map((s) => `  ${s.connected ? "●" : "○"} ${s.type}`)
    .join("\n");

  return `${transportLines}\n  Trusted users: ${stats.trustedUsers}`;
}

// ── Help ────────────────────────────────────────────────────────────────────

function showHelp(mctx: MenuContext): void {
  mctx.ui.notify(
    "Subcommands:\n" +
    "  /msg-bridge status                — show connection status\n" +
    "  /msg-bridge connect               — connect all transports\n" +
    "  /msg-bridge disconnect            — disconnect all transports\n" +
    "  /msg-bridge configure <platform>  — set up a transport\n" +
    "  /msg-bridge widget                — toggle status widget",
    "info",
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function doConnect(mctx: MenuContext): Promise<void> {
  if (!acquireLock()) {
    mctx.ui.notify("⚠️ Another instance is already connected.", "warning");
    return;
  }
  try {
    await mctx.transportManager.connectAll();
    const cfg = loadConfig();
    cfg.autoConnect = true;
    saveConfig(cfg);
    mctx.ui.notify("✅ Connected to all configured transports", "info");
    mctx.updateWidget();
  } catch (err) {
    releaseLock();
    mctx.ui.notify(`❌ Connection failed: ${(err as Error).message}`, "error");
  }
}

async function doDisconnect(mctx: MenuContext): Promise<void> {
  await mctx.transportManager.disconnectAll();
  releaseLock();
  const cfg = loadConfig();
  cfg.autoConnect = false;
  saveConfig(cfg);
  mctx.ui.notify("🔌 Disconnected from all transports", "info");
  mctx.updateWidget();
}

async function doConfigure(mctx: MenuContext): Promise<void> {
  const platform = await mctx.ui.select("Configure transport", [
    "Telegram",
    "WhatsApp",
    "Slack",
    "Discord",
    "Matrix",
  ]);
  if (!platform) return;

  const config = loadConfig();

  switch (platform) {
    case "Telegram": {
      const token = await mctx.ui.input("Telegram bot token");
      if (!token) return;
      config.telegram = { token };
      saveConfig(config);
      const provider = new TelegramProvider(token, mctx.auth);
      mctx.transportManager.addTransport(provider);
      if (acquireLock()) {
        try {
          await provider.connect();
          mctx.ui.notify("✅ Telegram configured and connected", "info");
        } catch (_err) {
          releaseLock();
          mctx.ui.notify("✅ Telegram configured (run /msg-bridge connect to activate)", "info");
        }
      } else {
        mctx.ui.notify("✅ Telegram configured (another instance is connected — run /msg-bridge connect later)", "info");
      }
      break;
    }
    case "WhatsApp": {
      const authPath = await mctx.ui.input("Auth path (enter for default, esc to cancel)");
      if (authPath === undefined) return; // cancelled
      config.whatsapp = authPath ? { authPath } : {};
      saveConfig(config);
      const whatsappConfig = { ...config.whatsapp, debug: config.debug };
      const provider = new WhatsAppProvider(whatsappConfig, mctx.auth);
      mctx.transportManager.addTransport(provider);
      if (acquireLock()) {
        try {
          await provider.connect(true);
          mctx.ui.notify("✅ WhatsApp configured and connecting (scan QR code in terminal)...", "info");
        } catch (err) {
          releaseLock();
          mctx.ui.notify(`⚠️ WhatsApp setup error: ${(err as Error).message}`, "error");
        }
      } else {
        mctx.ui.notify("✅ WhatsApp configured (another instance is connected — run /msg-bridge connect later)", "info");
      }
      break;
    }
    case "Slack": {
      const botToken = await mctx.ui.input("Slack bot token (xoxb-...)");
      if (!botToken) return;
      const appToken = await mctx.ui.input("Slack app token (xapp-...)");
      if (!appToken) return;
      config.slack = { ...config.slack, botToken, appToken };
      saveConfig(config);
      const slackConfig = { ...config.slack, debug: config.debug };
      const provider = new SlackProvider(slackConfig, mctx.auth);
      mctx.transportManager.addTransport(provider);
      if (acquireLock()) {
        try {
          await provider.connect();
          mctx.ui.notify("✅ Slack configured and connected", "info");
        } catch (err) {
          releaseLock();
          mctx.ui.notify(`⚠️ Slack setup error: ${(err as Error).message}`, "error");
        }
      } else {
        mctx.ui.notify("✅ Slack configured (another instance is connected — run /msg-bridge connect later)", "info");
      }
      break;
    }
    case "Discord": {
      const token = await mctx.ui.input("Discord bot token");
      if (!token) return;
      config.discord = { token };
      saveConfig(config);
      const provider = new DiscordProvider(config.discord, mctx.auth);
      mctx.transportManager.addTransport(provider);
      if (acquireLock()) {
        try {
          await provider.connect();
          mctx.ui.notify("✅ Discord configured and connected", "info");
        } catch (err) {
          releaseLock();
          mctx.ui.notify(`⚠️ Discord setup error: ${(err as Error).message}`, "error");
        }
      } else {
        mctx.ui.notify("✅ Discord configured (another instance is connected — run /msg-bridge connect later)", "info");
      }
      break;
    }
    case "Matrix": {
      const homeserverUrl = await mctx.ui.input("Matrix homeserver URL (e.g. https://matrix.org)");
      if (!homeserverUrl) return;
      const accessToken = await mctx.ui.input("Matrix access token");
      if (!accessToken) return;
      config.matrix = { homeserverUrl, accessToken };
      saveConfig(config);
      const provider = new MatrixProvider(config.matrix, mctx.auth);
      mctx.transportManager.addTransport(provider);
      if (acquireLock()) {
        try {
          await provider.connect();
          mctx.ui.notify("✅ Matrix configured and connected", "info");
        } catch (err) {
          releaseLock();
          mctx.ui.notify(`⚠️ Matrix setup error: ${(err as Error).message}`, "error");
        }
      } else {
        mctx.ui.notify("✅ Matrix configured (another instance is connected — run /msg-bridge connect later)", "info");
      }
      break;
    }
  }
  mctx.updateWidget();
}

function doToggleWidget(mctx: MenuContext): void {
  const cfg = loadConfig();
  cfg.showWidget = cfg.showWidget === false;
  saveConfig(cfg);
  const state = cfg.showWidget !== false ? "shown" : "hidden";
  mctx.ui.notify(`📊 Status widget ${state}`, "info");
  mctx.updateWidget();
}

// ── Main menu ───────────────────────────────────────────────────────────────

export async function openMainMenu(mctx: MenuContext): Promise<void> {
  const mainMenu = async (): Promise<void> => {
    const statusLine = getStatusLine(mctx);
    const title = `Message Bridge\n${statusLine}`;

    const anyConnected = mctx.transportManager.getStatus().some((s) => s.connected);

    const choices = [
      anyConnected ? "Disconnect" : "Connect",
      "Configure",
      "Widget",
      "Help",
    ];

    const choice = await mctx.ui.select(title, choices);
    if (!choice) return;

    switch (choice) {
      case "Connect":
        await doConnect(mctx);
        break;
      case "Disconnect":
        await doDisconnect(mctx);
        break;
      case "Configure":
        await doConfigure(mctx);
        break;
      case "Widget":
        doToggleWidget(mctx);
        break;
      case "Help":
        showHelp(mctx);
        break;
    }
    return mainMenu();
  };
  await mainMenu();
}
