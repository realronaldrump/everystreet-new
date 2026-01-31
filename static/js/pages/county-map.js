import { onPageLoad } from "../modules/utils.js";
import initCountyMapPage from "../modules/features/county-map/index.js";

onPageLoad(initCountyMapPage, { route: "/county-map" });
