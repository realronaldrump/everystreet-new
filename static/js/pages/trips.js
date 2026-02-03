import initTripsPage from "../modules/features/trips/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initTripsPage, { route: "/trips" });
