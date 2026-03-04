import bootstrapPage from "../modules/core/page-bootstrap.js";
import initTripsPage from "../modules/features/trips/index.js";

bootstrapPage(initTripsPage, (path) => path === "/trips" || path.startsWith("/trips/"));
