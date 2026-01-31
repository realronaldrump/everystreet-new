import { onPageLoad } from "../modules/utils.js";
import initMapMatchingPage from "../modules/features/map-matching/index.js";

onPageLoad(initMapMatchingPage, { route: "/map-matching" });
