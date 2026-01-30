const version = new URL(import.meta.url).searchParams.get("v");
const suffix = version ? `?v=${encodeURIComponent(version)}` : "";

import(`../trips.js${suffix}`).catch((error) => {
  console.error("Failed to load trips module", error);
});
