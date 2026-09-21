"use client"

import { useId } from "react"
import { Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils/cn"
import {
  FILTER_OPERATORS,
  VALUELESS_OPERATORS,
  deriveAttributeValues,
  isRowActive,
  newFilterRow,
  type FilterCombinator,
  type FilterOperator,
  type FilterRow,
  type FilterState,
  type FilterableItem,
} from "@/lib/vmodel/filter"

interface FilterBuilderProps {
  /** The unfiltered working set - attributes and value suggestions come from it. */
  items: FilterableItem[]
  attributes: string[]
  value: FilterState
  onChange: (next: FilterState) => void
}

/**
 * The only manipulation surface in the explorer.
 *
 * Every field of an item is a filterable attribute and the attribute list is
 * derived from the loaded data, so a new backend field appears here without a
 * frontend change.
 *
 * Rows are combined with ONE global AND/OR. Nested groups are not supported and
 * the UI says so in plain words - an OR control must never silently apply AND.
 */
export function FilterBuilder({ items, attributes, value, onChange }: FilterBuilderProps) {
  const listId = useId()

  const setCombinator = (combinator: FilterCombinator) => {
    onChange({ ...value, combinator })
  }

  const updateRow = (id: string, patch: Partial<FilterRow>) => {
    onChange({
      ...value,
      rows: value.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    })
  }

  const removeRow = (id: string) => {
    onChange({ ...value, rows: value.rows.filter((row) => row.id !== id) })
  }

  const addRow = () => {
    onChange({ ...value, rows: [...value.rows, newFilterRow(attributes[0] ?? "")] })
  }

  const clearAll = () => {
    onChange({ combinator: value.combinator, rows: [] })
  }

  const activeCount = value.rows.filter(isRowActive).length

  return (
    <div className="shrink-0 border-b px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filter
        </p>
        <div className="flex items-center gap-1">
          {/* Global combinator - applies to every row */}
          <div className="flex overflow-hidden rounded-md border" role="group" aria-label="Combinator">
            {(["AND", "OR"] as FilterCombinator[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setCombinator(option)}
                aria-pressed={value.combinator === option}
                className={cn(
                  "px-2 py-1 text-xs font-medium transition-colors",
                  value.combinator === option
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
              >
                {option}
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={addRow}
            disabled={attributes.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>

      {/* Rows are chips that flow horizontally and wrap - never one chip per line by construction */}
      {value.rows.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {value.rows.map((row) => (
            <FilterChip
              key={row.id}
              row={row}
              attributes={attributes}
              suggestions={deriveAttributeValues(items, row.attribute)}
              listId={`${listId}-${row.id}`}
              onChange={(patch) => updateRow(row.id, patch)}
              onRemove={() => removeRow(row.id)}
            />
          ))}
        </div>
      )}

      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        Rows are combined with a single AND/OR. Nested groups such as (A AND B) OR C are
        not supported.
      </p>

      {activeCount > 0 && (
        <button
          type="button"
          onClick={clearAll}
          className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Clear {activeCount} condition{activeCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  )
}

interface FilterChipProps {
  row: FilterRow
  attributes: string[]
  suggestions: string[]
  listId: string
  onChange: (patch: Partial<FilterRow>) => void
  onRemove: () => void
}

function FilterChip({
  row,
  attributes,
  suggestions,
  listId,
  onChange,
  onRemove,
}: FilterChipProps) {
  const needsValue = !VALUELESS_OPERATORS.includes(row.operator)

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 px-1.5 py-1">
      <Select
        value={row.attribute || undefined}
        onValueChange={(next) => onChange({ attribute: next })}
      >
        <SelectTrigger
          className="h-7 w-auto min-w-[7rem] gap-1 border-0 bg-transparent px-1 text-xs focus:ring-0 focus:ring-offset-0"
          aria-label="Attribute"
        >
          <SelectValue placeholder="attribute" />
        </SelectTrigger>
        <SelectContent>
          {attributes.map((attribute) => (
            <SelectItem key={attribute} value={attribute} className="text-xs">
              {attribute}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={row.operator}
        onValueChange={(next) => onChange({ operator: next as FilterOperator })}
      >
        <SelectTrigger
          className="h-7 w-auto min-w-[6.5rem] gap-1 border-0 bg-transparent px-1 text-xs text-muted-foreground focus:ring-0 focus:ring-offset-0"
          aria-label="Operator"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FILTER_OPERATORS.map((operator) => (
            <SelectItem key={operator.value} value={operator.value} className="text-xs">
              {operator.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsValue && (
        <>
          <Input
            value={row.value}
            onChange={(event) => onChange({ value: event.target.value })}
            list={listId}
            placeholder="value"
            aria-label="Value"
            className="h-7 w-28 border-0 bg-transparent px-1 text-xs focus-visible:ring-0 focus-visible:ring-offset-0 md:text-xs"
          />
          <datalist id={listId}>
            {suggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        </>
      )}

      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove condition"
        className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  )
}
