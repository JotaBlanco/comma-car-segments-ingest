"use client";

import { useState } from "react";
import { ChevronDown, LayoutDashboard, List, Plus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { createWorkbook, useWorkbooks, type Workbook } from "@/lib/workbooks";

/**
 * The workbook's name, and the way to another: a click opens the saved workbooks with a
 * filter, and picking one opens it on the same session, signals and period.
 */
export function WorkbookPicker({ workbook }: { workbook: Workbook }) {
  const router = useRouter();
  const params = useSearchParams();
  const workbooks = useWorkbooks();
  const [open, setOpen] = useState(false);
  const query = params?.toString() ?? "";
  const go = (id: string) => {
    setOpen(false);
    router.push(`/workbooks/${encodeURIComponent(id)}${query ? `?${query}` : ""}`);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "max-w-[18rem] font-semibold text-ink-1",
        )}
        aria-label={`Workbook ${workbook.name}: switch workbook`}
        title="Switch workbook"
      >
        <LayoutDashboard className="text-ink-3" />
        <span className="min-w-0 truncate">{workbook.name}</span>
        <ChevronDown className="text-ink-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[20rem] p-0">
        <Command>
          <CommandInput placeholder="Filter workbooks…" aria-label="Filter workbooks" />
          <CommandList>
            <CommandEmpty>No workbook matches.</CommandEmpty>
            <CommandGroup heading="Workbooks">
              {workbooks.map((w) => (
                <CommandItem
                  key={w.id}
                  value={`${w.name} ${w.id}`}
                  onSelect={() => go(w.id)}
                  aria-current={w.id === workbook.id ? "true" : undefined}
                  className={cn(w.id === workbook.id && "font-semibold")}
                >
                  <LayoutDashboard className={cn(w.id !== workbook.id && "opacity-40")} />
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {w.sessions.length > 0 && (
                    <span className="font-mono text-[0.68rem] text-ink-3">
                      {w.sessions.length} {w.sessions.length === 1 ? "session" : "sessions"}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="new workbook"
                onSelect={() => {
                  const w = createWorkbook("New workbook");
                  if (w !== null) go(w.id);
                }}
              >
                <Plus /> New workbook
              </CommandItem>
              <CommandItem
                value="all workbooks"
                onSelect={() => {
                  setOpen(false);
                  router.push("/workbooks");
                }}
              >
                <List /> All workbooks
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
