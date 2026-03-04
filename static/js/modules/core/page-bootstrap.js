import { onPageLoad } from "../utils.js";
import { createPageContext } from "./page-context.js";

export function bootstrapPage(initFeature, route) {
  onPageLoad(
    ({ signal, cleanup } = {}) =>
      initFeature(createPageContext({ signal: signal || null, cleanup })),
    { route }
  );
}

export default bootstrapPage;
