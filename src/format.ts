/**
 * Post text for LinkedIn's `commentary` field, which uses the "little" text format:
 * every reserved character must be backslash-escaped, even where it means nothing,
 * or LinkedIn cuts or garbles the text.
 * https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 */

export const RESERVED = ["\\", "|", "{", "}", "@", "[", "]", "(", ")", "<", ">", "#", "*", "_", "~"] as const;

/** LinkedIn's limit for a post's text (the API docs only say FIELD_LENGTH_TOO_LONG). */
export const MAX_COMMENTARY = 3000;

const RESERVED_RE = /[\\|{}@[\]()<>#*_~]/g;

export const escapeLittleText = (text: string) => text.replace(RESERVED_RE, (c) => `\\${c}`);

/** #word, at the start or after whitespace, with letters and digits only */
const HASHTAG_RE = /(^|\s)#([\p{L}\p{N}]+)(?=$|[\s.,;:!?])/gu;

/**
 * Plain text → commentary: escapes reserved characters and keeps #hashtags as hashtags
 * ({hashtag|\#|word}). Line breaks are kept. The length is checked on the plain text.
 */
export function formatCommentary(text: string, options: { hashtags?: boolean } = {}): string {
  const plain = text.replace(/\r\n?/g, "\n").trim();
  if (!plain) throw new RangeError("A post needs text.");
  if ([...plain].length > MAX_COMMENTARY) throw new RangeError(`A post's text is limited to ${MAX_COMMENTARY} characters; this one has ${[...plain].length}.`);
  if (options.hashtags === false) return escapeLittleText(plain);
  let out = "";
  let last = 0;
  for (const m of plain.matchAll(HASHTAG_RE)) {
    const start = m.index + m[1].length;
    out += escapeLittleText(plain.slice(last, start)) + `{hashtag|\\#|${m[2]}}`;
    last = start + 1 + m[2].length;
  }
  return out + escapeLittleText(plain.slice(last));
}

/**
 * Commentary as LinkedIn returns it → plain text (hashtag templates back to #word,
 * mentions to their name, escapes removed). For matching a post against the text that was sent.
 */
export function plainText(commentary: string): string {
  return commentary
    .replace(/\{hashtag\|\\?[#＃]\|([^}]+)\}/g, "#$1")
    .replace(/@\[([^\]]*)\]\(urn:li:[^)]+\)/g, "$1")
    .replace(/\\([\\|{}@[\]()<>#*_~])/g, "$1");
}
