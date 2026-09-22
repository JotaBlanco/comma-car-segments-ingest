import { Fragment, type ReactNode } from "react";

/**
 * Deliberately tiny markdown renderer for AI answer text and for a
 * requirements document.
 *
 * The platform model answers in markdown whether we ask it to or not, and raw
 * `**` / `|---|` characters read as a rendering bug. A requirements document
 * carries the same shapes, plus headings and lists. This renders exactly those
 * shapes — **bold**, `inline code`, pipe tables, `#` to `###` headings,
 * bullet lists, numbered lists, `---` horizontal rules and ``` fenced code
 * blocks — and nothing else. No links (an authored link is an injection
 * surface — the assistant routes its links through validated `deeplink` frames
 * instead), no images, no raw HTML, no new dependency. Every value goes
 * through React as text, so the content can never become markup.
 *
 * The rule and the fence landed on 25 Aug 2026. The Add-document dialog tells
 * a person the document holds "plain text or markdown"; a person then typed
 * both, and the page printed three dashes and three backticks as characters.
 * That made the promise on the dialog false, so the renderer now keeps it.
 *
 * **Known half-support, and deliberate.** A construct below renders in its
 * simple form only, and a document that needs more gets the plain characters:
 *
 * - A heading stops at `###`. A `####` line stays a paragraph.
 * - A list never nests, and an indented item joins the same flat list.
 * - `*emphasis*` with one star is not italic. Only `**bold**` renders.
 * - A table needs a leading and a trailing pipe on every row, and it never
 *   reads the `:---:` alignment.
 * - A fence ignores the language word after the opening ``` — there is no
 *   highlighting and no highlighting library.
 * - A blockquote (`>`) and a link (`[a](b)`) render as plain characters, and
 *   the link stays out on purpose.
 * - One newline inside a paragraph stays a line break. Real markdown joins
 *   those lines into one. This keeps them apart, because a requirements
 *   document is written in lines and a reader expects to read it in lines.
 * - `**bold**` never spans two lines: each line is marked up on its own.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  // Split on **bold** and `code` spans; everything else is plain text.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const key = `${keyBase}-${index}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <b key={key} className="font-semibold">
          {part.slice(2, -2)}
        </b>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={key} className="rounded-sm bg-surface-2 px-1 font-mono text-[0.78em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isTableLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorLine = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

/**
 * `#` to `###`. A deeper level stays plain text, because nothing we render
 * needs one and a fourth level would sit below the panel's own outline.
 */
const HEADING_RE = /^(#{1,3})\s+(.*\S)\s*$/;
/**
 * A bullet needs a space after the marker. `**bold**` therefore never reads as
 * a bullet, because the second character is a star and not a space.
 */
const BULLET_RE = /^\s*[-+*]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
/**
 * Three or more dashes on their own line. A table separator carries pipes, so
 * `|---|` never matches here, and the table branch reads it first anyway.
 */
const RULE_RE = /^\s*-{3,}\s*$/;
/**
 * The opening or closing line of a fenced code block. The capture holds the
 * language word, and this renderer drops it: it highlights nothing.
 */
const FENCE_RE = /^\s*```(.*)$/;

/**
 * The panel head owns `h2`, so the document's own top level is `h3`. The
 * document then extends the page outline instead of breaking it.
 */
const HEADING_TAGS = ["h3", "h4", "h5"] as const;
const HEADING_CLASSES = [
  "mt-3 mb-1 text-[0.86rem] font-bold tracking-[-0.01em]",
  "mt-2.5 mb-1 text-[0.8rem] font-bold tracking-[-0.01em]",
  "mt-2 mb-0.5 text-[0.78rem] font-semibold text-ink-2",
];

const startsBlock = (line: string) =>
  isTableLine(line) ||
  HEADING_RE.test(line) ||
  BULLET_RE.test(line) ||
  ORDERED_RE.test(line) ||
  RULE_RE.test(line) ||
  FENCE_RE.test(line);

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    // The fence comes first, so a `#` or a `|` inside a code block stays code.
    if (FENCE_RE.test(lines[index])) {
      const start = index;
      index += 1;
      const body: string[] = [];
      while (index < lines.length && !FENCE_RE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      // An unclosed fence ends at the end of the text. Stepping past the
      // closing line only when there is one keeps the loop moving either way.
      if (index < lines.length) index += 1;
      blocks.push(
        // The body goes in as ONE React text child, so every character — `<`,
        // `&`, a whole `<script>` tag — reaches the DOM as text and never as
        // markup. `<pre>` keeps the whitespace the author typed.
        <pre
          key={start}
          className="my-2 overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-[0.76rem] whitespace-pre"
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    if (RULE_RE.test(lines[index])) {
      blocks.push(<hr key={index} className="my-3 border-t border-line" />);
      index += 1;
      continue;
    }

    if (isTableLine(lines[index])) {
      const start = index;
      while (index < lines.length && isTableLine(lines[index])) index += 1;
      const rows = lines.slice(start, index).filter((line) => !isSeparatorLine(line));
      const [head, ...body] = rows.map(tableCells);
      blocks.push(
        // The global th/td styles carry the app's table look; the wrapper
        // keeps a wide table scrollable instead of overflowing the panel.
        <div key={start} className="my-2 overflow-x-auto rounded-md border border-line">
          <table className="w-full">
            <thead>
              <tr>
                {head.map((cell, cellIndex) => (
                  <th key={cellIndex}>{inline(cell, `h${start}-${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((cells, rowIndex) => (
                <tr key={rowIndex}>
                  {cells.map((cell, cellIndex) => (
                    <td key={cellIndex} className="text-[0.8rem]">
                      {inline(cell, `b${start}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = HEADING_RE.exec(lines[index]);
    if (heading !== null) {
      const level = heading[1].length - 1;
      const Heading = HEADING_TAGS[level];
      blocks.push(
        <Heading key={index} className={HEADING_CLASSES[level]}>
          {inline(heading[2], `h${index}`)}
        </Heading>,
      );
      index += 1;
      continue;
    }

    // A list runs while the marker keeps repeating. The two markers never mix,
    // so a bullet run and a numbered run stay separate blocks.
    const bullet = BULLET_RE.test(lines[index]);
    if (bullet || ORDERED_RE.test(lines[index])) {
      const itemRe = bullet ? BULLET_RE : ORDERED_RE;
      const start = index;
      const items: string[] = [];
      for (let match = itemRe.exec(lines[index]); match !== null; ) {
        items.push(match[1]);
        index += 1;
        match = index < lines.length ? itemRe.exec(lines[index]) : null;
      }
      const List = bullet ? "ul" : "ol";
      blocks.push(
        <List
          key={start}
          className={`my-2 space-y-0.5 pl-5 ${bullet ? "list-disc" : "list-decimal"}`}
        >
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{inline(item, `l${start}-${itemIndex}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    // A paragraph runs to the next blank line or to the next block. Single
    // newlines stay as line breaks.
    const start = index;
    while (index < lines.length && lines[index].trim().length > 0 && !startsBlock(lines[index])) {
      index += 1;
    }
    if (index > start) {
      const paragraph = lines.slice(start, index);
      blocks.push(
        <p key={start} className="whitespace-pre-wrap">
          {paragraph.map((line, lineIndex) => (
            <Fragment key={lineIndex}>
              {lineIndex > 0 && "\n"}
              {inline(line, `p${start}-${lineIndex}`)}
            </Fragment>
          ))}
        </p>,
      );
    } else {
      index += 1; // blank line
    }
  }

  return <div className="space-y-2">{blocks}</div>;
}
