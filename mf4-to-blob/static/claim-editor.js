/**
 * The claim on one file's row.
 *
 * Every field arrives prefilled from that recording's own header properties
 * (mdf-header.js), per file, because one card cannot state four run ids. A
 * field the operator TYPED rides as `declared.<name>`: an untouched prefill
 * states nothing on the wire, so the recording stays the source of the fact and
 * the ladder in `mf4-decoder/identity.py` resolves it exactly as it does for a
 * blank form. A typed value beats the recording, which is what the ladder has
 * always done and the whole point of the page.
 *
 * `platform` is the one field that does not work that way - it carries
 * `alwaysSend`, because the CAN database is chosen from the metadata message
 * before the file is downloaded and no ladder can read the recording in time.
 * `declaredQuery` says what silence would cost.
 *
 * The caller owns the row and the upload; this module owns `entry.claims`,
 * `entry.header` and the nodes under `entry.claimUi`.
 */
import { readHeaderClaims } from '/static/mdf-header.js';

// The five claims the form owns: the `declared.*` name each rides as, the
// header property it is prefilled from, and whether it rides untouched. Order
// is the one the summary line states - the run first, because it is the one
// that differs per file; the platform with the campaign-scoped facts.
const CLAIM_FIELDS = [
    { name: 'run_id', label: 'Run id', headerKey: 'run_key', placeholder: 'TAS-1001' },
    { name: 'work_order_id', label: 'Work order', headerKey: 'work_order', placeholder: 'WO-2026-0851' },
    { name: 'platform', label: 'Platform', headerKey: 'platform', placeholder: 'Porsche_Taycan', alwaysSend: true },
    { name: 'rig_id', label: 'Rig', headerKey: 'rig', placeholder: 'RIG-04' },
    { name: 'vehicle', label: 'Vehicle', headerKey: 'vehicle', placeholder: 'VIN, or whatever names the car' },
];

// What the bulk control copies. The other four describe the bench session; the
// run id identifies THIS recording, and copying it across a selection is
// precisely how four traces end up in one run. A mixed Taycan+Macan selection
// is why this is a per-file button and not one shared card: copy one platform
// across, then correct the files that state the other.
const BULK_FIELDS = ['work_order_id', 'platform', 'rig_id', 'vehicle'];

const CLAIM_NOTE =
    "These values come from the file's own header. Change one only if it is wrong: what you " +
    "type is sent as your claim and outranks the recording. Clearing a field is not a claim " +
    "— the recording's value is used. A field the recording does not state stays blank, " +
    "and a blank field is resolved from the file when it is decoded. Platform is the one " +
    "exception: it chooses the CAN database the file is decoded with and it is the lake's " +
    "top-level folder, so whatever stands in that box is sent whether or not you touch it " +
    "— nothing downstream can read it out of the recording in time.";

/** Give one entry its claim state: every field empty, no header read yet. */
export function initClaims(entry) {
    entry.claims = {};
    for (const field of CLAIM_FIELDS) {
        entry.claims[field.name] = { value: '', dirty: false };
    }
    // null until the read resolves; {} when the file states no claim.
    entry.header = null;
    entry.expanded = false;
}

/** Read the file's own claim and fill the editor with it. */
export function loadHeader(entry) {
    readHeaderClaims(entry.file).then(header => applyHeader(entry, header));
}

function applyHeader(entry, header) {
    entry.header = header;
    for (const field of CLAIM_FIELDS) {
        const stated = header[field.headerKey] || '';
        // A value typed while the read was in flight is already the answer.
        if (stated && !entry.claims[field.name].dirty) {
            entry.claims[field.name].value = stated;
            entry.claimUi.inputs[field.name].value = stated;
        }
    }
    // Nothing to summarise, and the case where a claim may need typing.
    if (!Object.keys(header).length) entry.expanded = true;
    paintClaims(entry);
}

/**
 * The summary line, its Edit toggle and the editor's inputs, built once.
 *
 * @param {object} entry the file entry, already through initClaims
 * @param {function} onBulk applies this entry's campaign fields to every other
 * @returns {HTMLElement} the block to hang in the row
 */
export function buildClaimBlock(entry, onBulk) {
    const block = document.createElement('div');

    const line = document.createElement('div');
    line.className = 'claim-line';
    const stated = document.createElement('span');
    const toggle = document.createElement('button');
    toggle.className = 'claim-toggle';
    toggle.type = 'button';
    toggle.onclick = () => { entry.expanded = !entry.expanded; paintClaims(entry); };
    line.append(stated, toggle);

    const editor = document.createElement('fieldset');
    editor.className = 'claim';
    const legend = document.createElement('legend');
    legend.append('Test Manager claim ');
    const hint = document.createElement('span');
    hint.className = 'claim-hint';
    legend.appendChild(hint);
    editor.appendChild(legend);

    const grid = document.createElement('div');
    grid.className = 'claim-grid';
    const inputs = {};
    const chips = {};
    const reverts = {};
    for (const field of CLAIM_FIELDS) {
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.className = 'claim-caption';
        caption.append(field.label);

        const chip = document.createElement('span');
        chip.className = 'chip';
        const revert = document.createElement('button');
        revert.className = 'revert';
        revert.type = 'button';
        revert.title = 'Back to what the recording states';
        revert.textContent = '↺';
        revert.onclick = () => revertClaim(entry, field);
        caption.append(' ', chip, revert);

        const input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.placeholder = field.placeholder;
        input.value = entry.claims[field.name].value;
        // Dirty on the ACT of typing, with no comparison against the prefill:
        // retyping the identical string still makes it the operator's claim.
        input.addEventListener('input', () => {
            entry.claims[field.name] = { value: input.value, dirty: true };
            paintClaims(entry);
        });

        label.append(caption, input);
        grid.appendChild(label);
        inputs[field.name] = input;
        chips[field.name] = chip;
        reverts[field.name] = revert;
    }
    editor.appendChild(grid);

    const bulk = document.createElement('button');
    bulk.className = 'claim-bulk';
    bulk.type = 'button';
    bulk.textContent = 'Use this work order, platform, rig and vehicle for every file';
    bulk.onclick = onBulk;
    editor.appendChild(bulk);

    const note = document.createElement('p');
    note.className = 'claim-note';
    note.textContent = CLAIM_NOTE;
    editor.appendChild(note);

    block.append(line, editor);
    entry.claimUi = { stated, toggle, hint, editor, inputs, chips, reverts };
    paintClaims(entry);
    return block;
}

/**
 * Repaint the summary line, the chips, the revert controls and the editor's
 * open state. It never writes an input's value, which is what makes it safe to
 * call from the input handler itself, on every keystroke.
 */
function paintClaims(entry) {
    const header = entry.header || {};
    const ui = entry.claimUi;
    const stated = CLAIM_FIELDS.map(f => header[f.headerKey]).filter(Boolean);

    if (!entry.header) {
        ui.stated.textContent = 'reading the recording...';
    } else if (stated.length) {
        ui.stated.textContent = 'from the recording · ' + stated.join(' · ');
    } else {
        ui.stated.textContent = 'this recording states no Test Manager claim';
    }
    ui.hint.textContent = stated.length
        ? '— read from the recording'
        : '— this recording states nothing';

    for (const field of CLAIM_FIELDS) {
        const claim = entry.claims[field.name];
        ui.chips[field.name].className = 'chip' + (claim.dirty ? ' typed' : '');
        ui.chips[field.name].textContent = claim.dirty
            ? 'typed'
            : (header[field.headerKey] ? 'from the recording' : '');
        ui.reverts[field.name].hidden = !claim.dirty;
    }

    ui.editor.hidden = !entry.expanded;
    ui.toggle.textContent = entry.expanded ? 'Hide' : 'Edit';
}

// Back to "the recording answers this". Without it a stray keystroke would
// convert a field permanently, which is this page's defect in miniature.
function revertClaim(entry, field) {
    const stated = (entry.header || {})[field.headerKey] || '';
    entry.claims[field.name] = { value: stated, dirty: false };
    entry.claimUi.inputs[field.name].value = stated;
    paintClaims(entry);
}

/** Copy the campaign fields onto every other entry. They were typed - here. */
export function applyToAll(entries, source) {
    for (const entry of entries) {
        if (entry === source) continue;
        for (const name of BULK_FIELDS) {
            const value = source.claims[name].value;
            entry.claims[name] = { value, dirty: true };
            entry.claimUi.inputs[name].value = value;
        }
        paintClaims(entry);
    }
}

/**
 * This file's claim as a `declared.*` query string, leading "&" and all, or ""
 * when nothing contributes. Read off the live entry at SEND time, so a
 * correction typed before the click is the claim that travels.
 *
 * A field the operator typed contributes. An untouched prefill is the
 * recording's own statement, not a claim, and sending it would fill the one
 * channel that means "a person decided this" with facts nobody stated.
 *
 * `alwaysSend` breaks that rule for `platform`, and only for it. The decoder
 * keys the DBC lookup on the metadata message before it downloads the file
 * (`mf4-decoder/main.py`, `F_DCM_KEY`), so silence there does not mean "read it
 * off the recording" as it does for every other field - it means the
 * deployment-wide `DBC_PLATFORM`, which would decode a Macan with the Taycan
 * database while this form displayed the right answer nobody retyped.
 *
 * An empty value contributes nothing either, typed or not. `declared.run_id=`
 * would state an EMPTY run id, which is a different claim from stating none:
 * the server validates it, rejects it as malformed, and the upload fails on a
 * field somebody cleared. So a recording that states no platform still sends
 * none, and `DBC_PLATFORM` answers it exactly as it does today.
 */
export function declaredQuery(entry) {
    let query = '';
    for (const field of CLAIM_FIELDS) {
        const claim = entry.claims[field.name];
        const value = (claim.dirty || field.alwaysSend) ? claim.value.trim() : '';
        if (value) {
            query += '&declared.' + field.name + '=' + encodeURIComponent(value);
        }
    }
    return query;
}

/**
 * What the RECORDING states about the car, sent whether or not anybody typed
 * anything, so the stored object carries `x-ms-meta-vehicle` on every upload
 * (`mf4-to-blob/metadata.py::object_metadata`). It is not a claim and never
 * enters the declared bag; a typed vehicle outranks it server-side.
 */
export function stampQuery(entry) {
    const stated = ((entry.header || {}).vehicle || '').trim();
    return stated ? '&vehicle=' + encodeURIComponent(stated) : '';
}
