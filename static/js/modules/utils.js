// Utils module shim
// Ensures that other ES modules can import { default as utils } from './utils.js'
// while still supporting legacy global window.utils created by the original script.

// If utils is not yet initialised, dynamically import the legacy script.
if (!window.utils) {
  await import("../utils.js"); // this executes the legacy script and defines window.utils
}

const {utils} = window;
export { utils as default };

export const {handleError} = window;
