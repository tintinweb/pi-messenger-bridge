/**
 * Pure utility for converting LLM-emitted GFM-style markdown into Slack's mrkdwn format.
 * No SDK or network dependencies — extracted for testability.
 */

const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

/**
 * Convert GFM tables into padded, fixed-width text wrapped in a code fence.
 * Slack mrkdwn has no table syntax, so a monospaced preformatted block is the pragmatic fallback.
 */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const sepLine = lines[i + 1];

    if (line.includes("|") && sepLine?.includes("-") && TABLE_SEP_RE.test(sepLine)) {
      const rows: string[][] = [splitTableRow(line)];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
        rows.push(splitTableRow(lines[j]));
        j++;
      }

      const colCount = Math.max(...rows.map((r) => r.length));
      const widths = Array.from({ length: colCount }, (_, c) =>
        Math.max(...rows.map((r) => (r[c] ?? "").length))
      );
      const renderRow = (cells: string[]) =>
        Array.from({ length: colCount }, (_, c) => (cells[c] ?? "").padEnd(widths[c])).join(" | ");

      const tableLines = [
        renderRow(rows[0]),
        widths.map((w) => "-".repeat(w)).join("-|-"),
        ...rows.slice(1).map(renderRow),
      ];
      out.push(`\`\`\`\n${tableLines.join("\n")}\n\`\`\``);
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return out.join("\n");
}

/**
 * Convert standard/GFM markdown to Slack's mrkdwn format.
 *
 * Slack mrkdwn syntax: *bold*, _italic_, ~strike~, `code`, ```pre```, <url|text>, no headers/tables.
 *
 * Strategy: convert tables to plain fenced text first (so they get protected like any other code
 * block), then lift code and converted-markup into NUL-sentinel placeholders in priority order so
 * later regexes never re-match already-converted syntax (same trick as telegram.ts/matrix-utils.ts),
 * then restore.
 */
export function formatForSlack(text: string): string {
  if (!/[*_~`#[|-]/.test(text)) return text;

  text = convertTables(text);

  const lifted: string[] = [];
  const lift = (s: string) => `\x00${lifted.push(s) - 1}\x00`;

  // Protect code (includes fences produced by convertTables above)
  text = text.replace(/```[\s\S]*?```/g, lift);
  text = text.replace(/`[^`]+`/g, lift);

  // Bullets before bold/italic: "* item" is followed by whitespace, unlike "*italic*" — converting
  // bullets first removes the ambiguous leading asterisk so the (multiline-spanning) italic regex
  // below can't pair a bullet marker with an unrelated asterisk later in the text.
  text = text.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // Headers: converted on raw text as a self-contained transform (links resolved inline via plain
  // substitution, emphasis markers stripped rather than preserved). Slack has no nested bold, so a
  // header like "## **Important**" collapses to one bold span instead of wrapping an already-bold
  // span in a second pair of asterisks.
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, t) => {
    const clean = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>").replace(/[*_~]+/g, "");
    return lift(`*${clean}*`);
  });

  // Italic/strike/link before bold: bold's content class only excludes "*", so a nested "~~strike~~"
  // or "[link](url)" would still match fine — but if left until after bold, that inner syntax is
  // already lifted away inside the bold span and never reaches its own regex. Converting all three
  // first (and lifting them) means bold ends up capturing placeholder tokens instead of raw syntax,
  // and the iterative restore below resolves the resulting nesting correctly. The italic regex's
  // adjacency guards already ignore genuine "**"/"***" runs (a lone "*" next to another "*" never
  // qualifies as a delimiter), so this also fixes "**bold *and italic* together**", which would
  // otherwise fail to match bold's content class at all and leave the outer "**" untouched.
  text = text.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, (_, c) => lift(`_${c}_`)); // *italic* → _italic_
  text = text.replace(/~~([^~]+?)~~/g, (_, c) => lift(`~${c}~`)); // ~~strike~~ → ~strike~
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => lift(`<${u}|${t}>`)); // [text](url) → <url|text>
  text = text.replace(/\*\*\*([^*]+?)\*\*\*/g, (_, c) => lift(`*_${c}_*`)); // ***bold italic*** → *_bold italic_*
  text = text.replace(/\*\*([^*]+?)\*\*/g, (_, c) => lift(`*${c}*`)); // **bold** → *bold*

  // Restore iteratively: a lifted span can itself contain another placeholder (e.g. bold wrapping an
  // already-lifted nested italic span), so a single pass would leave raw sentinel bytes behind.
  let prev: string;
  do {
    prev = text;
    text = text.replace(/\x00(\d+)\x00/g, (_, i) => lifted[parseInt(i, 10)]);
  } while (text !== prev);

  return text;
}
