import initRoutesPage from "../modules/features/routes/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initRoutesPage, {
  route: (path) => path === "/routes" || path.startsWith("/routes/"),
});
