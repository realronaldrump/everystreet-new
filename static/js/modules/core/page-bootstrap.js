import { onPageLoad } from "../utils.js";
import { createPageContext } from "./page-context.js";

function bootstrapPage(initFeature, route) {
  onPageLoad(
    ({ signal, cleanup } = {}) => {
      if (window.AUTH_CONTEXT?.viewerMode) {
        // The base template already shows the viewer-mode notice.
        return null;
      }
      const context = createPageContext({ signal: signal || null, cleanup });
      const result = initFeature(context);
      if (result?.then)
        return result.then((teardown) => {
          context.onCleanup(teardown);
        });
      context.onCleanup(result);
      return undefined;
    },
    { route }
  );
}

export default bootstrapPage;
