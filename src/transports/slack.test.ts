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
