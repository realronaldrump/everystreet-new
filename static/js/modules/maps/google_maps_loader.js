const GOOGLE_MAPS_SCRIPT_ID = "es-google-maps-js-api";
const INTERNAL_LOAD_TIMEOUT_MS = 30000;

let googleMapsLoadPromise = null;

const getWindow = () => globalThis?.window || globalThis;

const getBootstrapConfig = () => getWindow()?.GOOGLE_MAPS_BOOTSTRAP || {};

const getBootstrapState = () => getWindow()?.__esGoogleMapsLoadState || null;

const getBootstrapPromise = () => getWindow()?.__esGoogleMapsLoadPromise || null;

const normalizeError = (error, fallbackMessage) => {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string" && error.trim()) {
    return new Error(error.trim());
  }
  return new Error(fallbackMessage);
};

const getGoogleMapsScript = () => {
  if (typeof document === "undefined") {
    return null;
  }

  const configuredScriptId = getBootstrapConfig().scriptId;
  return (
    document.getElementById(configuredScriptId || GOOGLE_MAPS_SCRIPT_ID) ||
    document.querySelector("script[data-google-maps-loader='true']")
  );
};

const buildGoogleMapsLoadError = () => {
  const bootstrapState = getBootstrapState();
  const provider = String(getWindow()?.MAP_PROVIDER || "")
    .trim()
    .toLowerCase();

  if (bootstrapState?.status === "failed" && bootstrapState.error) {
    return new Error(bootstrapState.error);
  }

  if (provider === "google" && getBootstrapConfig().configured === false) {
    return new Error(
      "Google Maps provider is selected, but no Google Maps API key is configured."
    );
  }

  if (provider === "google") {
    return new Error(
      "Google Maps JavaScript API script was not rendered on the page."
    );
  }

  return new Error("Google Maps JS not loaded");
};

async function ensureMapsLibraryLoaded() {
  const maps = getGoogleMapsApi();
  if (!maps) {
    return false;
  }

  if (typeof maps.importLibrary === "function") {
    await maps.importLibrary("maps");
  }

  return typeof getGoogleMapsApi()?.Map === "function";
}

function createInternalLoadPromise() {
  return new Promise((resolve, reject) => {
    const bootstrapState = getBootstrapState();
    if (bootstrapState?.status === "failed") {
      reject(buildGoogleMapsLoadError());
      return;
    }

    const bootstrapPromise = getBootstrapPromise();
    const script = getGoogleMapsScript();
    if (!script) {
      reject(buildGoogleMapsLoadError());
      return;
    }

    let settled = false;
    let intervalId = null;
    let timeoutId = null;

    const cleanup = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      if (script && typeof script.removeEventListener === "function") {
        script.removeEventListener("load", handleScriptLoad);
        script.removeEventListener("error", handleScriptError);
      }
    };

    const settleResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(true);
    };

    const settleReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(normalizeError(error, "Google Maps JS not loaded"));
    };

    const resolveWhenReady = () => {
      void (async () => {
        if (settled) {
          return;
        }
        try {
          if (!(await ensureMapsLibraryLoaded())) {
            return;
          }
          settleResolve();
        } catch (error) {
          settleReject(error);
        }
      })();
    };

    const handleScriptLoad = () => {
      resolveWhenReady();
    };

    const handleScriptError = () => {
      settleReject(buildGoogleMapsLoadError());
    };

    if (typeof bootstrapPromise?.then === "function") {
      bootstrapPromise.then(resolveWhenReady).catch((error) => {
        settleReject(error);
      });
    }

    if (script && typeof script.addEventListener === "function") {
      script.addEventListener("load", handleScriptLoad);
      script.addEventListener("error", handleScriptError);
    }

    timeoutId = setTimeout(() => {
      settleReject(
        new Error(
          "Timed out while loading Google Maps JavaScript API. Check your API key and allowed referrers."
        )
      );
    }, INTERNAL_LOAD_TIMEOUT_MS);

    intervalId = setInterval(resolveWhenReady, 50);
    resolveWhenReady();
  });
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          "Timed out while waiting for Google Maps JavaScript API to become ready."
        )
      );
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export function getGoogleMapsApi() {
  return globalThis?.google?.maps || null;
}

export function hasGoogleMapsApi() {
  return Boolean(getGoogleMapsApi());
}

export function waitForGoogleMaps(timeoutMs = 10000) {
  const immediateCheck = ensureMapsLibraryLoaded();
  const pendingPromise = immediateCheck.then((isReady) => {
    if (isReady) {
      return true;
    }

    googleMapsLoadPromise ||= createInternalLoadPromise();
    return googleMapsLoadPromise;
  });

  return withTimeout(pendingPromise, timeoutMs);
}

export function __resetGoogleMapsLoaderForTests() {
  googleMapsLoadPromise = null;
}
