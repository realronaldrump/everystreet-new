import { onPageLoad } from "../modules/utils.js";
import initTripsPage from "../modules/features/trips/index.js";

onPageLoad(initTripsPage, { route: "/trips" });
