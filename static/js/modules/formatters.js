/**
 * Formatters Module (compat)
 * Keep legacy imports to /static/js/modules/formatters.js working.
 */

import * as formatting from "./utils/formatting.js";
import { getStorage, removeStorage, setStorage } from "./utils/data.js";

const formatters = {
  ...formatting,
  getStorage,
  removeStorage,
  setStorage,
};

export default formatters;
export * from "./utils/formatting.js";
export { getStorage, removeStorage, setStorage };
