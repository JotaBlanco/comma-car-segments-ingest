import Link from "next/link";
import { Children, Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CrumbsProps {
  children: ReactNode;
  className?: string;
}

export function Crumbs({ children, className }: CrumbsProps) {
  const items = Children.toArray(children);
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("mb-3.5 flex flex-wrap items-center gap-[7px] text-[0.75rem]", className)}
    >
      {items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span aria-hidden className="text-ink-3">
              ›
            </span>
          )}
          {item}
        </Fragment>
      ))}
    </nav>
  );
}

interface CrumbProps {
  type: string;
  current?: boolean;
  missing?: boolean;
  href?: string;
  children: ReactNode;
  className?: string;
}

export function Crumb({
  type,
  current = false,
  missing = false,
  href,
  children,
  className,
}: CrumbProps) {
  const chipClass = cn(
    "inline-flex items-baseline rounded-sm border border-line bg-surface px-2 py-[3px] font-mono text-[0.72rem] text-ink-2",
    current &&
      "border-ink bg-ink text-bg dark:border-accent-fill dark:bg-accent-fill dark:text-accent-ink",
    missing && "border-dashed bg-transparent text-ink-3",
    !current && !missing && href !== undefined && "transition-colors hover:border-line-strong hover:text-ink",
    className
  );
  const typeLabel = (
    <span
      className={cn(
        "mr-[3px] font-sans text-[0.6rem] font-semibold tracking-[0.07em] uppercase",
        current ? "text-bg/60 dark:text-accent-ink" : "text-ink-3"
      )}
    >
      {type}
    </span>
  );

  if (href !== undefined && !current && !missing) {
    return (
      <Link href={href} className={chipClass}>
        {typeLabel}
        {children}
      </Link>
    );
  }
  return (
    <span className={chipClass} aria-current={current ? "page" : undefined}>
      {typeLabel}
      {children}
    </span>
  );
}
