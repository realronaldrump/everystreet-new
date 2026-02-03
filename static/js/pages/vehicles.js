import initVehiclesPage from "../modules/features/vehicles/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initVehiclesPage, { route: "/vehicles" });
