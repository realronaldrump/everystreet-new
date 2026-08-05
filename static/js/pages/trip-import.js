import bootstrapPage from "../modules/core/page-bootstrap.js";
import initManualTripImport from "../modules/features/trip-import/index.js";

bootstrapPage(initManualTripImport, (path) => path === "/trip-import");
