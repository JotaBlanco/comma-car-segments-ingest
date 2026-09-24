/**
 * The Test Manager claim an MF4 states about itself, read in the browser.
 *
 * Two ranged reads off the picked File - the 136-byte head, then at most 1 MiB
 * at the HD block's `md_comment` link - parsed into the same `test.*`
 * properties the decoder reads off the same comment
 * (`mf4-decoder/provenance.py::parse_header_properties`). `Blob.slice` is a
 * lazy reference, so a comment 2 GB into a file costs the range, not the
 * offset.
 *
 * Every unreadable case answers `{}`: a recording that states no claim is an
 * ordinary upload, not a fault.
 */

// ASAM MDF 4.x, fixed by the standard. A 64-byte ID block, then the HD block:
// 4 id bytes, 4 reserved, uint64 block_len, uint64 links_nr, then six int64
// links - dg_first, fh_first, ch_first, at_first, ev_first, md_comment.
// Every other block opens with the same 24-byte header.
const HD_OFFSET = 64;
const BLOCK_HEADER_LEN = 24;
const MD_LINK_OFFSET = HD_OFFSET + BLOCK_HEADER_LEN + 5 * 8;
const HEAD_BYTES = MD_LINK_OFFSET + 8;

const MAX_COMMENT_BYTES = 1 << 20;

// Header property -> the key this module answers with. The four the import
// form owns; the rest of the `test.*` block is the decoder's business.
const CLAIM_KEYS = {
    'test.run_key': 'run_key',
    'test.work_order': 'work_order',
    'test.rig': 'rig',
    'test.vehicle': 'vehicle',
};

/**
 * The file's own Test Manager claim, or `{}` when it states none.
 *
 * @param {File} file
 * @returns {Promise<{run_key?: string, work_order?: string, rig?: string, vehicle?: string}>}
 */
export async function readHeaderClaims(file) {
    try {
        const head = new DataView(await file.slice(0, HEAD_BYTES).arrayBuffer());
        if (blockId(head, HD_OFFSET) !== '##HD') return {};

        const commentAt = Number(head.getBigUint64(MD_LINK_OFFSET, true));
        if (!commentAt) return {};

        const buffer = await file
            .slice(commentAt, commentAt + BLOCK_HEADER_LEN + MAX_COMMENT_BYTES)
            .arrayBuffer();
        const block = new DataView(buffer);
        if (blockId(block, 0) !== '##MD') return {};

        // The comment is NUL-terminated and padded to an 8-byte boundary, so
        // block_len is an upper bound on the text, not its length.
        const end = Math.min(Number(block.getBigUint64(8, true)), buffer.byteLength);
        const text = new TextDecoder().decode(
            new Uint8Array(buffer, BLOCK_HEADER_LEN, end - BLOCK_HEADER_LEN)
        );
        return claimsFrom(new DOMParser().parseFromString(text.split('\0')[0], 'application/xml'));
    } catch {
        return {};
    }
}

function blockId(view, offset) {
    return String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1),
        view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
}

/**
 * Walk `<common_properties>` the way the decoder walks it: the local tag name,
 * so a namespaced document parses; the whole subtree, because entries may sit
 * in a `<tree>`; first occurrence wins on a repeated name.
 */
function claimsFrom(doc) {
    const properties = {};
    for (const element of doc.querySelectorAll('*')) {
        if (element.localName !== 'common_properties') continue;
        for (const entry of element.querySelectorAll('*')) {
            if (entry.localName !== 'e') continue;
            const name = (entry.getAttribute('name') || '').trim();
            if (name && !(name in properties)) {
                properties[name] = (entry.textContent || '').trim();
            }
        }
    }
    const claims = {};
    for (const [property, key] of Object.entries(CLAIM_KEYS)) {
        if (properties[property]) claims[key] = properties[property];
    }
    return claims;
}
