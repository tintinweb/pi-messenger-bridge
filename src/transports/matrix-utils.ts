/**
 * Pure utility functions for Matrix transport.
 * Extracted for testability — no SDK or network dependencies.
 */

/** Escape HTML special characters */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert markdown to Matrix HTML. Returns plain body + optional formatted HTML. */
export function formatForMatrix(text: string): { body: string; formattedBody?: string } {
  const hasMarkdown = /[*_`#\[]/.test(text);
  if (!hasMarkdown) {
    return { body: text };
  }

  let html = text;

  // Protect code blocks
  const codeBlocks: string[] = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `__INLINECODE_${inlineCodes.length - 1}__`;
  });

  // Bold
  html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  // Italic
  html = html.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Newlines to <br>
  html = html.replace(/\n/g, "<br>");

  // Restore code blocks and inline code
  html = html.replace(/__CODEBLOCK_(\d+)__/g, (_, idx) => codeBlocks[parseInt(idx)]);
  html = html.replace(/__INLINECODE_(\d+)__/g, (_, idx) => inlineCodes[parseInt(idx)]);

  return { body: text, formattedBody: html };
}

/**
 * Determine whether to skip a Matrix room event before processing.
 * Returns a reason string if the event should be skipped, or null if it should be processed.
 */
export function shouldSkipEvent(
  event: { sender?: string; origin_server_ts?: number; content?: any },
  botUserId: string,
  connectedAt: number,
  joinedRooms: Set<string>,
  roomId: string
): string | null {
  // Ignore own messages
  if (event.sender === botUserId) return "own_message";

  // Skip events from before this connection (stale replay from initial sync)
  const eventTs = event.origin_server_ts || 0;
  if (eventTs < connectedAt) return "stale";

  // Only process text messages
  const content = event.content;
  if (!content || content.msgtype !== "m.text" || !content.body) return "not_text";

  // Ignore edits (we only process original messages)
  if (content["m.new_content"]) return "edit";

  // Skip events from rooms we're not in (cached, no API call)
  if (!joinedRooms.has(roomId)) return "not_joined";

  return null;
}

/** Extract Matrix username (localpart) from a full MXID like @user:matrix.org */
export function extractUsername(userId: string): string {
  return userId.replace(/^@/, "").replace(/:.*$/, "");
}

/** Check if bot was mentioned in message text by full MXID or localpart */
export function wasBotMentioned(messageText: string, botUserId: string): boolean {
  return (
    messageText.includes(botUserId) ||
    messageText.toLowerCase().includes(botUserId.split(":")[0].substring(1).toLowerCase())
  );
}

/** Strip bot mention from message text */
export function stripBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(botUserId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "")
    .trim();
}
