import L from 'leaflet';

/** Top-down eVTOL; rotate the inner element, not the marker. */
export function aircraftIcon(fill: string, stroke: string): L.DivIcon {
  const svg =
    '<svg viewBox="0 0 40 40" width="34" height="34"><g class="ac" style="transform-origin:20px 20px">' +
    '<path d="M20 3 L23 16 L37 19 L37 22 L23 23 L22 33 L26 36 L26 38 L20 36 L14 38 L14 36 L18 33 L17 23 L3 22 L3 19 L17 16 Z" ' +
    `style="fill:${fill};stroke:${stroke};stroke-width:1.2"/></g></svg>`;
  return L.divIcon({ html: svg, className: 'ac-marker', iconSize: [34, 34], iconAnchor: [17, 17] });
}
