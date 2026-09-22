"use client";

/**
 * The Flight Test Station as a piece of the Test Manager: the station's own
 * app, code for code, mounted on a workbook. The URL is the station's entry
 * contract (`?run=&signal=&t=&sel=`), which the workbook page already speaks,
 * so the station boots on the run the page names. The store draws the
 * workbook's layout and hands every change back through the handle.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { getActivePortalToken } from '@/lib/portal/token-store';
import App from './App';
import type { WorkbookHandle } from './api/workbook';
import { useSession } from './store/session';
import './index.css';

/** How long to wait for the viewer's Portal token before booting anyway. */
const TOKEN_WAIT_MS = 5_000;
const TOKEN_POLL_MS = 150;

/** True once the Test Manager's token is in hand, or once waiting is pointless. */
function useTokenReady(): boolean {
  const [ready, setReady] = useState(() => getActivePortalToken() !== null);
  useEffect(() => {
    if (ready) return undefined;
    const giveUpAt = Date.now() + TOKEN_WAIT_MS;
    const timer = setInterval(() => {
      if (getActivePortalToken() === null && Date.now() < giveUpAt) return;
      clearInterval(timer);
      setReady(true);
    }, TOKEN_POLL_MS);
    return () => clearInterval(timer);
  }, [ready]);
  return ready;
}

export default function Station({
  workbook,
  leading,
  trailing,
}: {
  workbook?: WorkbookHandle;
  /** The Test Manager's controls at the head of the station's header. */
  leading?: ReactNode;
  /** And before the layout controls at its end. */
  trailing?: ReactNode;
}) {
  const ready = useTokenReady();
  const openWorkbook = useSession((s) => s.openWorkbook);
  const closeWorkbook = useSession((s) => s.closeWorkbook);
  const name = workbook?.name;
  const layout = workbook?.layout;
  const onLayout = workbook?.onLayout;
  useEffect(() => {
    if (name === undefined || layout === undefined || onLayout === undefined) return undefined;
    openWorkbook({ name, layout, onLayout });
    return () => closeWorkbook();
    // The handle opens once per mount: the layout it then reports is the station's own doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, openWorkbook, closeWorkbook]);
  if (!ready) return <div className="fts-root h-full" aria-busy="true" />;
  return <App leading={leading} trailing={trailing} />;
}
