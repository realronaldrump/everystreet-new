import { onPageLoad } from "../modules/utils.js";
import initVehiclesPage from "../modules/features/vehicles/index.js";

onPageLoad(initVehiclesPage, { route: "/vehicles" });
