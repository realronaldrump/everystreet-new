import initSetupWizardPage from "../modules/features/setup-wizard/index.js";
import { onPageLoad } from "../modules/utils.js";

onPageLoad(initSetupWizardPage, { route: "/setup-wizard" });
