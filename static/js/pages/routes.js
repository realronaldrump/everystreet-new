import bootstrapPage from "../modules/core/page-bootstrap.js";
import initRoutesPage from "../modules/features/routes/index.js";

bootstrapPage(
  initRoutesPage,
  (path) => path === "/routes" || path.startsWith("/routes/")
);
