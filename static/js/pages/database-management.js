import { onPageLoad } from "../modules/utils.js";
import { initDatabaseManagement } from "../database-management.js";

onPageLoad(initDatabaseManagement, { route: "/database-management" });
