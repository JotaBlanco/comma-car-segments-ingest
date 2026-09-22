import type { Metadata } from "next";
import { IBM_Plex_Mono, Schibsted_Grotesk } from "next/font/google";
import { connection } from "next/server";
import { FtsConfigProvider } from "@/components/providers/fts-config-provider";
import { LakeConfigProvider } from "@/components/providers/lake-config-provider";
import { PortalConfigProvider } from "@/components/providers/portal-config-provider";
import { QueryProvider } from "@/components/providers/query-provider";
import { QuixLabConfigProvider } from "@/components/providers/quixlab-config-provider";
import { AppShell } from "@/components/shell/app-shell";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { resolveFtsConfig } from "@/lib/fts-server";
import { resolveQuixLabUrl } from "@/lib/quixlab-server";
import "./globals.css";

/**
 * Applies the persisted theme (localStorage "tm-theme") before first paint to
 * avoid a light-mode flash. Parent-app hook (1): a `?theme=dark|light` query
 * param overrides — and replaces — the stored value, so the embedding Quix app
 * can force alignment on load. Runtime switching is handled by ThemeProvider
 * via postMessage ({type:"tm-theme", theme:"dark"|"light"}).
 */
const themeInitScript = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var t=q==="dark"||q==="light"?q:localStorage.getItem("tm-theme");if(q==="dark"||q==="light")localStorage.setItem("tm-theme",q);if(t==="dark")document.documentElement.classList.add("dark")}catch(e){}})()`;

const sans = Schibsted_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  /* Every route names itself (FR-DM-091): child segments set a plain string
     title and the template appends the product name. The four client-side
     detail screens set `document.title` through `usePageTitle` instead,
     because their titles need the loaded entity — same suffix, one constant
     (`lib/page-title.ts`). */
  title: {
    template: "%s — Test Manager",
    default: "Test Manager — Quix",
  },
  description:
    "Registry of runs, files and signals — system of record for anything a human decides.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // `connection()` stops the prerender here, so everything below runs at
  // REQUEST time. Without it Next.js reads the variable while `next build`
  // runs, and the build machine's value goes into the image. That is the exact
  // fault the old `NEXT_PUBLIC_QUIX_PORTAL_API` name had: one image could serve
  // one environment only. See `next/dist/docs/.../04-functions/connection.md`.
  await connection();

  // The platform injects this name into every deployment, always, as a plain
  // variable (`plans/reference/QUIX-INJECTED-VARIABLES.md`, citing
  // `DeploymentService.cs:2173`). It reaches this server process, never the
  // browser, so the server reads it and `PortalConfigProvider` passes it down.
  // Absent, the account menu and the token handshake both fail loudly rather
  // than call a host that does not exist.
  const portalApiBase = process.env.Quix__Portal__Api ?? "";

  // The four "Open in QuixLab" controls show only when a real QuixLab answers.
  // The API owns that value: it reads `TM_QUIXLAB_URL` and serves it on
  // `GET /api/v1/integrations/quixlab-url`. This server asks that route, so one
  // name configures both sides. An empty string means no QuixLab, and every
  // control then stays hidden.
  // Together: two independent calls, each with its own 2 s timeout.
  const [quixLabUrl, fts] = await Promise.all([
    resolveQuixLabUrl(),
    resolveFtsConfig(),
  ]);

  // The PHYSICAL lake table Explore queries. The operator sets `TM_LAKE_TABLE`
  // on this deployment (the API reads the same name), and the workbench must
  // show that exact table and its exact column spellings — the hidden logical
  // renaming is gone, so what the user sees is what the lake receives.
  // `LakeConfigProvider` passes the value down; empty means "unset" and the
  // local stack's physical name applies (`lib/explore/lake-schema.ts`).
  const lakeTable = process.env.TM_LAKE_TABLE ?? "";

  // Where a SESSION sits in that table's partition tree, and what lies inside
  // one. The two pickers read different halves of the same tree — the sessions
  // dialog walks down to the run, the Explorer walks what is under it — and
  // nothing in the tree says where the cut is, so the operator states it.
  // Both are read here for the same reason the table name is: they reach the
  // server process only. Empty means "unset", and this estate's own shape
  // applies (`lib/explore/lake-partitions.ts`).
  const lakeSessionPartitions = process.env.TM_LAKE_SESSION_PARTITIONS ?? "";
  const lakeDataPartitions = process.env.TM_LAKE_DATA_PARTITIONS ?? "";

  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <PortalConfigProvider base={portalApiBase}>
          <QuixLabConfigProvider url={quixLabUrl}>
            <FtsConfigProvider url={fts.url} origin={fts.origin}>
              <LakeConfigProvider
                table={lakeTable}
                sessionPartitions={lakeSessionPartitions}
                dataPartitions={lakeDataPartitions}
              >
                <ThemeProvider>
                  <QueryProvider>
                    <AppShell>{children}</AppShell>
                  </QueryProvider>
                  <Toaster />
                </ThemeProvider>
              </LakeConfigProvider>
            </FtsConfigProvider>
          </QuixLabConfigProvider>
        </PortalConfigProvider>
      </body>
    </html>
  );
}
