import initProfilePage from "../modules/features/profile/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initProfilePage, { route: "/profile" });
