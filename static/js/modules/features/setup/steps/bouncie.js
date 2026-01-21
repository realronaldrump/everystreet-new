export function getBouncieFormValues(currentDevices, defaultConcurrency = 12) {
  const fetchConcurrency = Number.parseInt(
    document.getElementById("fetchConcurrency").value,
    10
  );
  return {
    client_id: document.getElementById("clientId").value.trim(),
    client_secret: document.getElementById("clientSecret").value.trim(),
    redirect_uri: document.getElementById("redirectUri").value.trim(),
    authorized_devices: currentDevices.map((device) => device.trim()),
    fetch_concurrency: Number.isFinite(fetchConcurrency)
      ? fetchConcurrency
      : defaultConcurrency,
  };
}
