import { onPageLoad } from "../utils.js";
import { createPageContext } from "./page-context.js";

function bootstrapPage(initFeature, route) {
  onPageLoad(
    ({ signal, cleanup } = {}) => {
      if (window.AUTH_CONTEXT?.viewerMode) {
        // The base template already shows the viewer-mode notice.
        return;
      }
      return initFeature(createPageContext({ signal: signal || null, cleanup }));
    },
    { route }
  );
}

export default bootstrapPage;
