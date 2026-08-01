import { describe, expect, it, vi } from "vitest";
import { ChallengeAuth } from "../auth/challenge-auth.js";
import { SlackProvider } from "./slack.js";

// ─── sendMessage thread anchoring ─────────────────────────────

function makeProvider() {
  const auth = new ChallengeAuth(
    () => {},
    () => {},
  );
  const provider = new SlackProvider(
    { botToken: "xoxb-test", appToken: "xapp-test" },
    auth,
  );
  const postMessage = vi.fn().mockResolvedValue({});
  // Stub the connected Bolt app so sendMessage reaches chat.postMessage.
  (provider as any).app = { client: { chat: { postMessage } } };
  return { provider, postMessage };
}

describe("SlackProvider.sendMessage", () => {
  it("includes thread_ts when a threadId is provided", async () => {
    const { provider, postMessage } = makeProvider();

    await provider.sendMessage("C123", "hi", "1680000000.0001");

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "hi",
        thread_ts: "1680000000.0001",
      }),
    );
  });

  it("omits thread_ts entirely when no threadId is provided", async () => {
    const { provider, postMessage } = makeProvider();

    await provider.sendMessage("C123", "hi");

    expect(postMessage).toHaveBeenCalledTimes(1);
    const payload = postMessage.mock.calls[0][0];
    expect(payload).not.toHaveProperty("thread_ts");
    expect(payload).toMatchObject({ channel: "C123", text: "hi" });
  });
});

describe("SlackProvider admin slash commands", () => {
  function makeCommandHarness(trusted = true, isDM = true) {
    const auth = new ChallengeAuth(
      () => {},
      () => {},
    );
    if (trusted) auth.loadFromConfig({ trustedUsers: ["slack:U123"] });
    const provider = new SlackProvider(
      { botToken: "xoxb-test", appToken: "xapp-test" },
      auth,
    );
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    const client = {
      conversations: {
        info: vi.fn().mockResolvedValue({ channel: { is_im: isDM, name: isDM ? undefined : "general" } }),
      },
    };
    return { provider, ack, respond, client };
  }

  it("acknowledges and dispatches a trusted DM /trusted command", async () => {
    const { provider, ack, respond, client } = makeCommandHarness();

    await (provider as any).handleAdminSlashCommand({
      command: { command: "/trusted", text: "", channel_id: "D123", user_id: "U123", user_name: "Ryan" },
      ack,
      respond,
      client,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      response_type: "ephemeral",
      text: expect.stringContaining("Trusted users (1)"),
    }));
  });

  it("rejects admin slash commands outside a DM", async () => {
    const { provider, ack, respond, client } = makeCommandHarness(true, false);

    await (provider as any).handleAdminSlashCommand({
      command: { command: "/channels", text: "", channel_id: "C123", user_id: "U123", user_name: "Ryan" },
      ack,
      respond,
      client,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("DM-only"),
    }));
  });

  it("starts challenge auth for an untrusted DM command", async () => {
    const { provider, ack, respond, client } = makeCommandHarness(false);

    await (provider as any).handleAdminSlashCommand({
      command: { command: "/help", text: "", channel_id: "D123", user_id: "U123", user_name: "Ryan" },
      ack,
      respond,
      client,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("6-digit code"),
    }));
  });
});
