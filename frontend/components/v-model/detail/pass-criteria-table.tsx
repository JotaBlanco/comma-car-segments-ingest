"use client"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { RequirementLink } from "./requirement-link"
import {
  formatReduce,
  formatRule,
  formatTolerance,
  formatWindow,
} from "@/lib/vmodel/criteria-format"
import type { PassCriterion } from "@/types/vmodel"

interface PassCriteriaTableProps {
  criteria: PassCriterion[]
  /** "all" | "any" - how the criteria combine into the case verdict. */
  logic: string
  versionIndex: Map<string, string>
}

/**
 * The pass criteria of a test case, as a table.
 *
 * Machine-evaluable criteria must read as data, never as prose and never as a
 * raw JSON dump - so `rule`, `reduce`, `window` and `tolerance` are rendered
 * through `lib/vmodel/criteria-format.ts` into short symbolic text
 * ("at most 3 s", "full trace", "plus/minus 0.05"). The description sits under the row it
 * belongs to rather than in a column, because it is a sentence and would
 * otherwise force every other column to one word per line.
 */
export function PassCriteriaTable({
  criteria,
  logic,
  versionIndex,
}: PassCriteriaTableProps) {
  if (criteria.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        None &mdash; this test case declares no machine-evaluable pass criteria.
      </p>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        The case passes when <span className="font-medium">{logic || "all"}</span> of the{" "}
        {criteria.length} criteria below pass.
      </p>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Signal</TableHead>
              <TableHead>Channel group</TableHead>
              <TableHead>Reduce</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Window</TableHead>
              <TableHead className="text-right">Tol.</TableHead>
              <TableHead className="text-right">Min n</TableHead>
              <TableHead>Verifies</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {criteria.map((criterion) => (
              <TableRow key={criterion.criterion_id} className="align-top">
                <TableCell className="font-mono text-xs font-medium">
                  {criterion.criterion_id}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  {criterion.signal}
                </TableCell>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  {criterion.channel_group}
                </TableCell>
                <TableCell className="text-xs">{formatReduce(criterion.reduce)}</TableCell>
                <TableCell className="whitespace-nowrap text-xs font-medium">
                  {formatRule(criterion.rule, criterion.unit)}
                </TableCell>
                <TableCell className="text-xs">{formatWindow(criterion.window)}</TableCell>
                <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">
                  {formatTolerance(criterion.tolerance)}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {criterion.min_samples}
                </TableCell>
                <TableCell>
                  <RequirementLink
                    reqId={criterion.requirement_ref}
                    versionIndex={versionIndex}
                    variant="inline"
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <dl className="space-y-1.5 pt-1">
        {criteria.map((criterion) => (
          <div key={criterion.criterion_id} className="flex gap-2 text-sm">
            <dt className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">
              {criterion.criterion_id}
            </dt>
            <dd className="min-w-0 text-sm leading-5">{criterion.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
