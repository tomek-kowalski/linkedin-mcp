/**
 * Post text for LinkedIn's `commentary` field, which uses the "little" text format:
 * every reserved character must be backslash-escaped, even where it means nothing,
 * or LinkedIn cuts or garbles the text.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 */

export const RESERVED = ["\\", "|", "{", "}", "@", "[", "]", "(", ")", "<", ">", "#", "*", "_", "~"] as const;

/**
 * Internal limit for a post's text, not a documented API limit: the Posts API only names
 * FIELD_LENGTH_TOO_LONG, without a number. 3000 characters is LinkedIn's limit in its own editor.
 */
export const MAX_COMMENTARY = 3000;

const RESERVED_RE = /[\\|{}@[\]()<>#*_~]/g;

export const escapeLittleText = (text: string) => text.replace(RESERVED_RE, (c) => `\\${c}`);

/**
 * #word at the start or after whitespace: letters and digits with at least one letter
 * (so "#12" stays text), ending at whitespace, punctuation or the end.
 */
const HASHTAG_RE = /(^|\s)#((?=[\p{N}]*\p{L})[\p{L}\p{M}\p{N}]+)(?=$|[\s.,;:!?])/gu;

/** Text as compared and counted: NFC (composed umlauts, ß unchanged), \n line breaks, trimmed. */
export const normalizeText = (text: string) => text.normalize("NFC").replace(/\r\n?/g, "\n").trim();

/** Length as a reader counts it: code points (an emoji is one, not two UTF-16 units). */
export const textLength = (text: string) => [...normalizeText(text)].length;

/**
 * Plain text → commentary: escapes reserved characters and keeps #hashtags as plain
 * `#word` hashtag elements (the form the Posts API create examples send). Line breaks are kept.
 * Throws a RangeError for an empty text or one over MAX_COMMENTARY.
 */
export function formatCommentary(text: string, options: { hashtags?: boolean } = {}): string {
  const plain = normalizeText(text);
  if (!plain) throw new RangeError("A post needs text.");
  const length = [...plain].length;
  if (length > MAX_COMMENTARY) throw new RangeError(`A post's text is limited to ${MAX_COMMENTARY} characters; this one has ${length}.`);
  if (options.hashtags === false) return escapeLittleText(plain);
  let out = "";
  let last = 0;
  for (const m of plain.matchAll(HASHTAG_RE)) {
    const start = m.index + m[1].length;
    out += escapeLittleText(plain.slice(last, start)) + `#${m[2]}`;
    last = start + 1 + m[2].length;
  }
  return out + escapeLittleText(plain.slice(last));
}

/**
 * Commentary as LinkedIn returns it → plain text (hashtag templates back to #word,
 * mentions to their name, escapes removed, NFC). For matching a post against the text that was sent.
 */
export function plainText(commentary: string): string {
  return normalizeText(
    commentary
      .replace(/\{hashtag\|\\?[#＃]\|([^}]+)\}/g, "#$1")
      .replace(/@\[([^\]]*)\]\(urn:li:[^)]+\)/g, "$1")
      .replace(/\\([\\|{}@[\]()<>#*_~])/g, "$1"),
  );
}
