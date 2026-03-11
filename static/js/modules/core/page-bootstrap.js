import { onPageLoad } from "../utils.js";
import { createPageContext } from "./page-context.js";

function renderViewerPlaceholder() {
  if (document.getElementById("viewer-mode-route-placeholder")) {
    return;
  }

  const routeContent = document.getElementById("route-content");
  if (!routeContent) {
    return;
  }

  const placeholder = document.createElement("section");
  placeholder.id = "viewer-mode-route-placeholder";
  placeholder.className = "container py-4";
  placeholder.innerHTML = `
    <div class="alert alert-secondary mb-0" role="status">
      Viewer mode keeps this page browsable, but disables live features and hides personal data until you log in.
    </div>
  `;

  routeContent.prepend(placeholder);
}

export function bootstrapPage(initFeature, route) {
  onPageLoad(
    ({ signal, cleanup } = {}) => {
      if (window.AUTH_CONTEXT?.viewerMode) {
        renderViewerPlaceholder();
        return;
      }
      return initFeature(createPageContext({ signal: signal || null, cleanup }));
    },
    { route }
  );
}

export default bootstrapPage;
