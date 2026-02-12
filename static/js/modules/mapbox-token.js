const readMetaToken = () => {
  if (typeof document === "undefined") {
    return "";
  }
  const meta = document.querySelector('meta[name="mapbox-access-token"]');
  return meta?.getAttribute("content")?.trim() || "";
};

export const getMapboxToken = () => readMetaToken();

export const isMapboxStyleUrl = (styleUrl) => {
  if (!styleUrl || typeof styleUrl !== "string") {
    return false;
  }
  const url = styleUrl.trim();
  return url.startsWith("mapbox://") || url.includes("api.mapbox.com");
};

export const waitForMapboxToken = async ({ timeoutMs = 2000 } = {}) => {
  const existing = getMapboxToken();
  if (existing) {
    return existing;
  }

  if (typeof document === "undefined") {
    throw new Error("Mapbox access token not configured");
  }

  const resolvedToken = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (value, error) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeoutId);
      observer.disconnect();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    const check = () => {
      const token = getMapboxToken();
      if (token) {
        finish(token);
      }
    };

    const observer = new MutationObserver(() => check());
    const root = document.head || document.documentElement;
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    const timeoutId = setTimeout(() => {
      finish(null, new Error("Mapbox access token not configured"));
    }, timeoutMs);

    check();
  });
  return resolvedToken;
};
