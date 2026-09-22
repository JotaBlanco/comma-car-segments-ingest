"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The key-and-value row editor for a custom property map.
 *
 * A run and a test definition both carry such a map, and both write it through
 * the same caps and the same refusal codes. The editor therefore lives here,
 * so the two screens can never offer different rules.
 *
 * The API holds the real check (`api/api/models/runs.py`
 * `check_custom_properties`). Everything below only spares a round trip and
 * names the offending row. It never replaces the server check.
 */

/* The caps the API holds for the property map (`api/api/models/runs.py`). A
   screen states them, so a person reads the rule before the route refuses the
   save. */
export const PROPERTY_KEY_MAX = 64;
export const PROPERTY_VALUE_MAX = 512;
export const PROPERTY_MAX_COUNT = 50;

/** One row of the property editor. `id` keeps React keys stable while typing. */
export interface PropertyRow {
  id: string;
  key: string;
  value: string;
}

let nextRowId = 0;

export function newRow(key = "", value = ""): PropertyRow {
  nextRowId += 1;
  return { id: `p${nextRowId}`, key, value };
}

export function rowsOf(properties: Record<string, string>): PropertyRow[] {
  return Object.entries(properties).map(([key, value]) => newRow(key, value));
}

/** The map the rows state. A later row of the same name wins, as an object does. */
export function mapOf(rows: PropertyRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * The first reason the rows cannot be saved, or null when they can.
 *
 * The route answers the same refusals, so this only spares a round trip and
 * names the offending row. It never replaces the server check.
 */
export function propertyProblem(rows: PropertyRow[]): string | null {
  if (rows.some((row) => row.key.trim().length === 0)) {
    return "A custom property needs a name. Fill every empty name in, or remove the row.";
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) return `Two custom properties are called "${row.key}". Rename one of them.`;
    seen.add(row.key);
  }
  const long = rows.find((row) => row.key.length > PROPERTY_KEY_MAX);
  if (long !== undefined) {
    return `The name "${long.key.slice(0, 20)}…" is longer than ${PROPERTY_KEY_MAX} characters.`;
  }
  const wide = rows.find((row) => row.value.length > PROPERTY_VALUE_MAX);
  if (wide !== undefined) {
    return `The value of "${wide.key}" is longer than ${PROPERTY_VALUE_MAX} characters.`;
  }
  if (rows.length > PROPERTY_MAX_COUNT) {
    return `A custom property map holds ${PROPERTY_MAX_COUNT} properties at most. Remove a row.`;
  }
  return null;
}

/** One sentence a person can act on, per property refusal the API answers. */
export const PROPERTY_FAILURES: Record<string, string> = {
  custom_property_key_required:
    "A custom property needs a name. Fill the empty name in, or remove the row.",
  custom_property_key_too_long: `A custom property name takes ${PROPERTY_KEY_MAX} characters at most. Shorten it and save again.`,
  custom_property_value_too_long: `A custom property value takes ${PROPERTY_VALUE_MAX} characters at most. Shorten it and save again.`,
  too_many_custom_properties: `A custom property map holds ${PROPERTY_MAX_COUNT} properties at most. Remove a row and save again.`,
};

interface CustomPropertiesEditorProps {
  rows: PropertyRow[];
  onRowsChange: (rows: PropertyRow[]) => void;
  /** What to say when the map is empty. Each screen names its own entity. */
  emptyMessage: string;
}

export function CustomPropertiesEditor({
  rows,
  onRowsChange,
  emptyMessage,
}: CustomPropertiesEditorProps) {
  const replace = (id: string, patch: Partial<PropertyRow>) => {
    onRowsChange(rows.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  return (
    <>
      {rows.length === 0 ? (
        <p className="text-[0.74rem] text-ink-3">{emptyMessage}</p>
      ) : (
        <ul className="grid gap-1.5">
          {rows.map((row, index) => (
            <li key={row.id} className="flex items-start gap-1.5">
              <Input
                aria-label={`Custom property ${index + 1} name`}
                value={row.key}
                placeholder="Name"
                maxLength={PROPERTY_KEY_MAX}
                className="text-[0.8rem]"
                onChange={(event) => replace(row.id, { key: event.target.value })}
              />
              <Input
                aria-label={`Custom property ${index + 1} value`}
                value={row.value}
                placeholder="Value"
                maxLength={PROPERTY_VALUE_MAX}
                className="text-[0.8rem]"
                onChange={(event) => replace(row.id, { value: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={
                  row.key.trim().length > 0
                    ? `Remove the custom property ${row.key}`
                    : `Remove the custom property row ${index + 1}`
                }
                onClick={() => onRowsChange(rows.filter((item) => item.id !== row.id))}
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rows.length >= PROPERTY_MAX_COUNT}
          onClick={() => onRowsChange([...rows, newRow()])}
        >
          <PlusIcon aria-hidden />
          Add property
        </Button>
      </div>
    </>
  );
}
