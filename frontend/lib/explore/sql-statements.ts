/**
 * Count the statements in a SQL text, so a route can refuse a second one.
 *
 * The lake's own read-only guard reads the FIRST word of the text only
 * (`quix-ts-datalake-api/query_manager.py`). So `SELECT 1; CREATE TABLE t(x
 * INT)` passes that guard, and DuckDB then runs the second statement. This
 * module is the front end's half of the answer: Explore sends one statement,
 * and a body with two is refused before the lake sees it.
 *
 * The naive test `/;\s*\S/` is wrong. A semicolon is ordinary text inside a
 * string, inside a quoted identifier and inside a comment. So the check
 * strips those spans first, and only then looks for a separating semicolon.
 *
 * Nothing here rewrites the query. The route forwards the caller's bytes
 * verbatim. The stripped copy exists for the count and dies with the check.
 */

/** A dollar quote opener: `$$`, or a tagged `$tag$`. DuckDB accepts both. */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** The index of the line break that ends this line, or the end of the text. */
function lineEnd(sql: string, start: number): number {
  for (let i = start; i < sql.length; i += 1) {
    if (sql[i] === "\n" || sql[i] === "\r") return i;
  }
  return sql.length;
}

/**
 * The index just past a quoted span that starts at `start`.
 *
 * SQL doubles the quote character to escape it — `'it''s'` is one string, and
 * `"a""b"` is one identifier. So a doubled quote continues the span.
 */
function quotedEnd(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  // The text ends inside the span. Swallow the rest.
  return sql.length;
}

/**
 * Remove every string, quoted identifier, comment and dollar-quoted block.
 *
 * The result keeps the code outside those spans, so a semicolon that survives
 * really separates two statements. The result is for the check only. It is
 * never sent anywhere and it is never valid SQL.
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // A line comment runs to the line break. The break itself stays.
    if (ch === "-" && next === "-") {
      i = lineEnd(sql, i);
      continue;
    }
    // A block comment runs to the closing marker, or to the end of the text.
    if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = quotedEnd(sql, i, ch);
      continue;
    }
    if (ch === "$") {
      // `$1` is a parameter, not a quote: the tag must start with a letter or
      // an underscore, or be empty.
      const opener = DOLLAR_TAG.exec(sql.slice(i));
      if (opener !== null) {
        const marker = opener[0];
        const close = sql.indexOf(marker, i + marker.length);
        i = close === -1 ? sql.length : close + marker.length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * True when the text holds one statement at most.
 *
 * A trailing semicolon is legal and passes: SQL ends a statement with it, and
 * the editor shows many queries written that way. Only a semicolon with code
 * after it means a second statement.
 */
export function isSingleStatement(sql: string): boolean {
  const bare = stripSqlLiteralsAndComments(sql);
  const separator = bare.indexOf(";");
  if (separator === -1) return true;
  return bare.slice(separator + 1).trim() === "";
}
