// A street can contain several separately discovered or uncovered portions.
// A fresh street replaces all its old portions, including portions that disappeared.
export function mergeStreetFeatures(previous, incoming) {
  const refreshed = new Set(incoming.map((feature) => feature.properties.segment_id));
  return [
    ...previous.filter((feature) => !refreshed.has(feature.properties.segment_id)),
    ...incoming,
  ];
}
