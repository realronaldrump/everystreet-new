import bootstrapPage from "../modules/core/page-bootstrap.js";
import initTripDetail from "../modules/features/trip-detail/index.js";

bootstrapPage(initTripDetail, /^\/trips\/[^/]+$/);
