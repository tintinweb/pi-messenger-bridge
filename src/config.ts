import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { MsgBridgeConfig } from "./types.js";

const CONFIG_DIR = path.join(os.homedir(), ".pi");
const CONFIG_PATH = path.join(CONFIG_DIR, "msg-bridge.json");

/**
 * Load config from file and env vars (env vars override file).
 */
export function loadConfig(): MsgBridgeConfig {
  const config: MsgBridgeConfig = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const stats = fs.statSync(CONFIG_PATH);
      const mode = stats.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(`⚠️  Config file ${CONFIG_PATH} has insecure permissions (${mode.toString(8)}). Should be 0600.`);
      }

      const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
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
  // Cross-signing knobs can refine an existing matrix block without requiring the
  // homeserver/token to also come from env (mixed file+env config is supported).
  if (config.matrix) {
    const xs = process.env.PI_MATRIX_SELF_CROSS_SIGN;
    if (xs !== undefined) {
      if (xs === "0" || xs.toLowerCase() === "false") config.matrix.selfCrossSign = false;
      else if (xs === "reset") config.matrix.selfCrossSign = "reset";
      else config.matrix.selfCrossSign = true;
    }
    if (process.env.PI_MATRIX_ACCOUNT_PASSWORD) {
      config.matrix.accountPassword = process.env.PI_MATRIX_ACCOUNT_PASSWORD;
    }
    if (process.env.PI_MATRIX_RECOVERY_KEY) {
      config.matrix.recoveryKey = process.env.PI_MATRIX_RECOVERY_KEY;
    }
  }

  return config;
}

/**
 * Save config to file with secure permissions.
 */
export function saveConfig(config: MsgBridgeConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch (err) {
    console.warn("Failed to set directory permissions:", err);
  }
}
