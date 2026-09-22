"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SingleSelect } from "@/components/shared/single-select";
import { EARS_PATTERNS, type EarsPattern, type RequirementMeasurand } from "@/types";

/**
 * The authored fields the add and the edit form share (authoring-controls
 * §8), matched to the committed `RequirementCreateRequest` /
 * `RequirementPatchRequest` (`api/api/models/requirements.py`) — no `asil`
 * field: it does not exist on either request model, so it is not offered
 * here (`requirements-page/spec.md` proposed it; it was not built).
 *
 * Multi-valued authored fields that are free-form lists on the wire
 * (`system_states`, `source`, `figure_refs`, `related_reqs`) take a single
 * comma-separated text box rather than a dedicated row editor per field —
 * light functional code over four near-identical list widgets. `measurand`
 * keeps its own row editor because it is not a flat string, it is
 * `{name, unit}`.
 */
export interface RequirementFormValues {
  title: string;
  text: string;
  chapter: string;
  ears_pattern: EarsPattern;
  system_states: string;
  rationale: string;
  source: string;
  verification_method: string;
  measurand: RequirementMeasurand[];
  revision: string;
  figure_refs: string;
  related_reqs: string;
  verification_criteria: string;
  status: string;
}

export function emptyRequirementFormValues(): RequirementFormValues {
  return {
    title: "",
    text: "",
    chapter: "",
    ears_pattern: "Ubiquitous",
    system_states: "",
    rationale: "",
    source: "",
    verification_method: "",
    measurand: [],
    revision: "0.1",
    figure_refs: "",
    related_reqs: "",
    verification_criteria: "",
    status: "Draft",
  };
}

/** Comma or newline separated free text into a trimmed, non-empty array. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function joinList(values: readonly string[] | undefined): string {
  return (values ?? []).join(", ");
}

const fieldClass = "text-[0.7rem] font-semibold text-ink-2";
const stateDrivenPatterns: readonly EarsPattern[] = ["StateDriven", "Complex"];
const measuredMethods = new Set(["test", "tests"]);

function MeasurandEditor({
  rows,
  onChange,
}: {
  rows: RequirementMeasurand[];
  onChange: (rows: RequirementMeasurand[]) => void;
}) {
  const replace = (index: number, patch: Partial<RequirementMeasurand>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="grid gap-1.5">
      {rows.length === 0 && <p className="text-[0.74rem] text-ink-3">No measurand yet.</p>}
      {rows.length > 0 && (
        <ul className="grid gap-1.5">
          {rows.map((row, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <Input
                aria-label={`Measurand ${index + 1} name`}
                value={row.name}
                placeholder="Name, e.g. t_batt"
                className="text-[0.8rem]"
                onChange={(event) => replace(index, { name: event.target.value })}
              />
              <Input
                aria-label={`Measurand ${index + 1} unit`}
                value={row.unit}
                placeholder="Unit, e.g. degC"
                className="text-[0.8rem]"
                onChange={(event) => replace(index, { unit: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove measurand ${index + 1}`}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
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
          onClick={() => onChange([...rows, { name: "", unit: "" }])}
        >
          <PlusIcon aria-hidden />
          Add measurand
        </Button>
      </div>
    </div>
  );
}

export function RequirementFormFields({
  values,
  onChange,
  statusOptions,
  showStatus = true,
}: {
  values: RequirementFormValues;
  onChange: (next: RequirementFormValues) => void;
  /** Free text when absent — the enum is customer configuration and this
      code does not own it (requirements-page spec §6). Passed only at
      create time, where the route restricts the choice to NEW/Draft. */
  statusOptions?: readonly string[];
  /** False on the edit form: the committed `RequirementPatchRequest` carries
      no `status` field, so there is nothing here for a status edit to send —
      the status shown at the top of the edit dialog is display-only. */
  showStatus?: boolean;
}) {
  const set = <K extends keyof RequirementFormValues>(key: K, value: RequirementFormValues[K]) =>
    onChange({ ...values, [key]: value });

  const needsSystemStates = stateDrivenPatterns.includes(values.ears_pattern);
  const needsMeasurand = measuredMethods.has(values.verification_method.trim().toLowerCase());

  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <label htmlFor="req-title" className={fieldClass}>
          Title
        </label>
        <Input
          id="req-title"
          value={values.title}
          className="text-[0.8rem]"
          onChange={(event) => set("title", event.target.value)}
        />
      </div>

      <div className="grid gap-1">
        <label htmlFor="req-text" className={fieldClass}>
          Text — the EARS &ldquo;shall&rdquo; sentence
        </label>
        <Textarea
          id="req-text"
          value={values.text}
          className="min-h-[76px] text-[0.8rem]"
          onChange={(event) => set("text", event.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1">
          <label htmlFor="req-chapter" className={fieldClass}>
            Chapter
          </label>
          <Input
            id="req-chapter"
            value={values.chapter}
            className="text-[0.8rem]"
            onChange={(event) => set("chapter", event.target.value)}
          />
        </div>
        <SingleSelect
          label="EARS pattern"
          value={values.ears_pattern}
          onChange={(value) => set("ears_pattern", value as EarsPattern)}
          options={EARS_PATTERNS.map((pattern) => ({ value: pattern, label: pattern }))}
        />
      </div>

      {needsSystemStates && (
        <div className="grid gap-1">
          <label htmlFor="req-system-states" className={fieldClass}>
            System states <span className="font-normal text-ink-3">(comma separated)</span>
          </label>
          <Input
            id="req-system-states"
            value={values.system_states}
            placeholder="e.g. Active-Cruise, Driver-Override"
            className="text-[0.8rem]"
            onChange={(event) => set("system_states", event.target.value)}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1">
          <label htmlFor="req-method" className={fieldClass}>
            Verification method
          </label>
          <Input
            id="req-method"
            value={values.verification_method}
            placeholder="Test, Analysis, Review…"
            className="text-[0.8rem]"
            onChange={(event) => set("verification_method", event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="req-revision" className={fieldClass}>
            Revision
          </label>
          <Input
            id="req-revision"
            value={values.revision}
            placeholder="0.1"
            className="text-[0.8rem]"
            onChange={(event) => set("revision", event.target.value)}
          />
        </div>
      </div>

      {needsMeasurand && (
        <div className="grid gap-1">
          <span className={fieldClass}>Measurands</span>
          <MeasurandEditor
            rows={values.measurand}
            onChange={(rows) => set("measurand", rows)}
          />
        </div>
      )}

      <div className="grid gap-1">
        <label htmlFor="req-rationale" className={fieldClass}>
          Rationale <span className="font-normal text-ink-3">(optional)</span>
        </label>
        <Textarea
          id="req-rationale"
          value={values.rationale}
          className="min-h-[56px] text-[0.8rem]"
          onChange={(event) => set("rationale", event.target.value)}
        />
      </div>

      <div className="grid gap-1">
        <label htmlFor="req-criteria" className={fieldClass}>
          Verification criteria <span className="font-normal text-ink-3">(optional)</span>
        </label>
        <Textarea
          id="req-criteria"
          value={values.verification_criteria}
          className="min-h-[56px] text-[0.8rem]"
          onChange={(event) => set("verification_criteria", event.target.value)}
        />
      </div>

      <div className="grid gap-1">
        <label htmlFor="req-source" className={fieldClass}>
          Source tags <span className="font-normal text-ink-3">(comma separated)</span>
        </label>
        <Input
          id="req-source"
          value={values.source}
          placeholder="STAKEHOLDER:…"
          className="text-[0.8rem]"
          onChange={(event) => set("source", event.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1">
          <label htmlFor="req-figure-refs" className={fieldClass}>
            Figure refs <span className="font-normal text-ink-3">(comma separated, F1–F6)</span>
          </label>
          <Input
            id="req-figure-refs"
            value={values.figure_refs}
            placeholder="F1, F2"
            className="text-[0.8rem]"
            onChange={(event) => set("figure_refs", event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="req-related" className={fieldClass}>
            Related requirements <span className="font-normal text-ink-3">(comma separated)</span>
          </label>
          <Input
            id="req-related"
            value={values.related_reqs}
            className="text-[0.8rem]"
            onChange={(event) => set("related_reqs", event.target.value)}
          />
        </div>
      </div>

      {showStatus &&
        (statusOptions !== undefined ? (
          <SingleSelect
            label="Status"
            value={values.status}
            onChange={(value) => set("status", value)}
            options={statusOptions.map((option) => ({ value: option, label: option }))}
          />
        ) : (
          <div className="grid gap-1">
            <label htmlFor="req-status" className={fieldClass}>
              Status <span className="font-normal text-ink-3">(the review flow moves this on)</span>
            </label>
            <Input
              id="req-status"
              value={values.status}
              className="text-[0.8rem]"
              onChange={(event) => set("status", event.target.value)}
            />
          </div>
        ))}
    </div>
  );
}
