import { redirect } from "next/navigation"

/**
 * The V-model chain starts at Requirements, so the app opens there.
 *
 * A server-side redirect rather than a client one: it avoids rendering a
 * dashboard frame that is immediately replaced, and it keeps "/" working for
 * anything that links to the app root (the Quix portal sidebar item does).
 */
export default function RootPage() {
  redirect("/requirements")
}
