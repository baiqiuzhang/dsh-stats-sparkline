/**
 * Host half of the dsh-stats-sparkline bundle.
 *
 * The Client module (./client.js) owns every pixel and every sample: this
 * plugin only needs a loader row so the web shell serves its browser bundle,
 * so the host half stays the no-op the official decoration template prescribes.
 */
export function apply() {}
