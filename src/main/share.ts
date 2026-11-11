/**
 * Getting a letter out of the realm: markdown for developers, a typeset PDF
 * for anyone, a plain-language rewrite for people who are not technical, and
 * the macOS share sheet for any of them.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BrowserWindow } from "electron";
import { Marked } from "marked";
import { letterRef } from "../shared/types.js";
import type { Letter, LetterPost } from "../shared/types.js";

export type ShareFormat = "md" | "pdf" | "plain";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Raw HTML in a letter is shown as text, never rendered, as in the panel.
const md = new Marked({ gfm: true, breaks: false });
md.use({ renderer: { html: ({ text }) => esc(text) } });

function who(p: LetterPost, settler: string): string {
  return p.author.kind === "you" ? settler : p.author.kind === "outside" ? p.author.name : p.author.name;
}

/** The posts that go out: the letter alone, or the thread, never what you binned. */
function shown(letter: Letter, replies: boolean): LetterPost[] {
  const posts = letter.posts.filter((p) => p.status !== "binned");
  return replies ? posts : posts.slice(0, 1);
}

const day = (t: number) => new Date(t).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });

export function fileName(letter: Letter, format: ShareFormat): string {
  const safe = letter.title.replace(/[\/\\:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const suffix = format === "plain" ? " (plain language).pdf" : format === "pdf" ? ".pdf" : ".md";
  return `${letterRef(letter)} ${safe}${suffix}`;
}

/** The letter, or its thread, as one markdown document. */
export function asMarkdown(letter: Letter, replies: boolean, settler: string): string {
  const posts = shown(letter, replies);
  if (posts.length === 1) return posts[0]!.body.trim() + "\n";
  return [
    `# ${letter.title}`,
    ``,
    `*${letterRef(letter)} · ${letter.kind} · ${day(letter.createdAt)}*`,
    ``,
    ...posts.map((p) => `---\n\n## ${who(p, settler)} · ${day(p.at)}\n\n${p.body.trim()}\n`),
  ].join("\n");
}

/** A clean printed page: serif, generous margins, nothing of the app about it. */
function page(title: string, meta: string, bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { margin: 22mm 20mm; }
    body { font: 11pt/1.55 Georgia, "Iowan Old Style", "Times New Roman", serif; color: #1d1a16; }
    header { border-bottom: 1px solid #c9bfae; padding-bottom: 10px; margin-bottom: 18px; }
    header h1 { font-size: 20pt; line-height: 1.2; margin: 0 0 4px; font-weight: normal; }
    header p { margin: 0; color: #6b6255; font-size: 9.5pt; letter-spacing: .02em; }
    h1 { font-size: 16pt; font-weight: normal; margin: 20px 0 8px; }
    h2 { font-size: 13pt; margin: 18px 0 6px; }
    h3 { font-size: 11.5pt; margin: 14px 0 4px; }
    p, li { orphans: 3; widows: 3; }
    ul, ol { padding-left: 1.3em; }
    code { font: 9.5pt ui-monospace, Menlo, monospace; background: #f3efe7; padding: 1px 4px; border-radius: 3px; }
    pre { background: #f3efe7; padding: 10px 12px; border-radius: 5px; overflow-wrap: anywhere; white-space: pre-wrap; }
    pre code { background: none; padding: 0; }
    blockquote { margin: 10px 0; padding-left: 12px; border-left: 3px solid #c9bfae; color: #4c463d; }
    table { border-collapse: collapse; margin: 10px 0; font-size: 10pt; }
    th, td { border: 1px solid #c9bfae; padding: 4px 8px; text-align: left; }
    hr { border: 0; border-top: 1px solid #d8d0c2; margin: 22px 0; }
    .post { break-inside: auto; }
    .post > h2.by { font-size: 10pt; font-weight: normal; color: #6b6255; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 6px; }
  </style></head><body><header><h1>${esc(title)}</h1><p>${esc(meta)}</p></header>${bodyHtml}</body></html>`;
}

/** The letter, or its thread, as a printable page. */
export function asHtml(letter: Letter, replies: boolean, settler: string, from: string): string {
  const posts = shown(letter, replies);
  const meta = `${letterRef(letter)} · ${from} · ${day(letter.createdAt)}`;
  // A lone plan carries its own title; do not print it twice.
  const strip = (b: string) => (posts.length === 1 ? b.replace(/^\s*#\s+.+\n/, "") : b);
  const body = posts.length === 1
    ? md.parse(strip(posts[0]!.body), { async: false }) as string
    : posts.map((p, i) => `${i ? "<hr>" : ""}<section class="post"><h2 class="by">${esc(who(p, settler))} · ${esc(day(p.at))}</h2>${md.parse(p.body, { async: false })}</section>`).join("");
  return page(letter.title, meta, body);
}

/** The plain-language rewrite as a printable page. */
export function plainHtml(letter: Letter, from: string): string {
  const body = letter.plain!.body.replace(/^\s*#\s+(.+)\n/, "");
  const title = letter.plain!.body.match(/^\s*#\s+(.+)$/m)?.[1]?.trim() || letter.title;
  return page(title, `${from} · ${day(letter.plain!.at)}`, md.parse(body, { async: false }) as string);
}

/** Print HTML to a PDF in a window that is never shown. */
export async function toPdf(html: string): Promise<Buffer> {
  const w = new BrowserWindow({ show: false, focusable: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await w.webContents.printToPDF({ pageSize: "Letter", printBackground: true });
  } finally {
    w.destroy();
  }
}

const PLAIN_PROMPT = `You rewrite technical documents for readers who are not technical: owners, managers, clients.

Keep every decision, risk, cost, date and open question. Drop implementation detail the reader cannot act on; where a technical idea matters, say what it means for them in a few plain words.

How to write:
- Plain, direct sentences. Say the thing; do not announce that you are about to.
- No jargon. If a technical word cannot be avoided, explain it once, briefly.
- Short headings and short paragraphs. Use a list only when the content really is a list.
- Do not use em dashes. Do not use the words delve, leverage, robust, seamless, streamline, crucial, landscape, or "in today's".
- No "it's not X, it's Y" constructions, no rhetorical questions, no groups of three for rhythm, no closing summary that repeats what was said.
- Keep the author's meaning. Do not add opinions, recommendations or praise that are not in the original.

Output markdown only. Start with a single "# " title in plain words. No preamble and nothing after the document.`;

/**
 * A plain-language rewrite, from a one-off Claude call that sees only the
 * document: no tools, no settings, no settlement woken. Trap 1 applies: one
 * iterator, read to the end.
 */
export async function writePlain(source: string, executable: string | undefined): Promise<string> {
  const q = query({
    prompt: `Rewrite this document.\n\n<document>\n${source}\n</document>`,
    options: {
      tools: [],
      settingSources: [],
      systemPrompt: PLAIN_PROMPT,
      maxTurns: 1,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  });
  const it = q[Symbol.asyncIterator]();
  let text = "";
  for (;;) {
    const { value, done } = await it.next();
    if (done) break;
    const m = value as SDKMessage;
    if (m.type === "result") {
      if (m.subtype !== "success") throw new Error(`The rewrite did not finish (${m.subtype}).`);
      text = m.result;
    }
  }
  if (!text.trim()) throw new Error("The rewrite came back empty.");
  return text.trim() + "\n";
}
