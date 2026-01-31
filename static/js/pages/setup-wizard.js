import { onPageLoad } from "../modules/utils.js";
import initSetupWizardPage from "../modules/features/setup-wizard/index.js";

onPageLoad(initSetupWizardPage, { route: "/setup-wizard" });
