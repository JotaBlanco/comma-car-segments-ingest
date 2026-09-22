/** uPlot x is seconds, clock and API are ms: convert only here. */
export const msToS = (ms: number): number => ms / 1000;

export const sToMs = (s: number): number => Math.round(s * 1000);
