import { onPageLoad } from "../modules/utils.js";
import initMapPage from "../modules/features/map/index.js";

onPageLoad(initMapPage, { route: "/map" });
