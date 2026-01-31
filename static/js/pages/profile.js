import { onPageLoad } from "../modules/utils.js";
import initProfilePage from "../modules/features/profile/index.js";

onPageLoad(initProfilePage, { route: "/profile" });
