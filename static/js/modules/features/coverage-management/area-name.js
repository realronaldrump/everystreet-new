/**
 * Short names for coverage areas. Geocoder names carry the whole address
 * ("Waco, McLennan County, Texas, 76705, United States"); pages print the
 * place itself as the title and the county and state beneath it.
 */

const US_STATE_CODES = Object.freeze({
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
  "puerto rico": "PR",
});

const COUNTRY_NAMES = new Set([
  "united states",
  "united states of america",
  "usa",
  "us",
]);
const POSTAL_CODE = /^\d{5}(?:-\d{4})?$/;

/**
 * Split a geocoder display name into the place and its region.
 * "Waco, McLennan County, Texas, 76705, United States" becomes
 * { name: "Waco", region: "McLennan County, TX" }.
 */
export function splitAreaName(displayName) {
  const parts = String(displayName || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !POSTAL_CODE.test(part))
    .filter((part) => !COUNTRY_NAMES.has(part.toLowerCase()));
  if (!parts.length) {
    return { name: "Coverage area", region: "" };
  }
  const [name, ...rest] = parts;
  const region = rest
    .map((part) => US_STATE_CODES[part.toLowerCase()] || part)
    .filter((part, index, list) => list.indexOf(part) === index)
    .join(", ");
  return { name, region };
}

/** The place and region on one line, for selects and labels. */
export function shortAreaName(displayName) {
  const { name, region } = splitAreaName(displayName);
  return region ? `${name}, ${region}` : name;
}
