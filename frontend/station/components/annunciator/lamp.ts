export interface Lamp {
  label: string;
  cls: string;
}

const NOT_AUTHORISED = /not\s+authori[sz]ed/i;

/** Unknown codes read neutral; a refusal reads as a warning. */
function classFor(text: string | undefined): string {
  if (text === undefined) return 'lamp-idle';
  return NOT_AUTHORISED.test(text) ? 'lamp-warn' : 'lamp-ok';
}

/** Label and lamp classes for one coded state sample. */
export function lampFor(
  value: number | null,
  texts: Record<string, string> | undefined,
  prefix: string,
  classes: Record<string, string>,
): Lamp {
  if (value === null) return { label: 'NO DATA', cls: 'lamp readout lamp-off' };
  const key = String(value);
  const text = texts?.[key];
  return {
    label: text ?? `${prefix} ${key}`,
    cls: `lamp readout ${classes[key] ?? classFor(text)}`,
  };
}
