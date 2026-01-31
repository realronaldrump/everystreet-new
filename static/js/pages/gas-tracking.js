import { onPageLoad } from "../modules/utils.js";
import initGasTrackingPage from "../modules/features/gas-tracking/index.js";

onPageLoad(initGasTrackingPage, { route: "/gas-tracking" });
