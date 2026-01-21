export function getBouncieFormValues() {
  const clientIdInput = document.getElementById("clientId");
  const clientSecretInput = document.getElementById("clientSecret");
  const redirectUriInput = document.getElementById("redirectUri");

  console.log("getBouncieFormValues inputs:", {
    clientIdInput,
    clientSecretInput,
    redirectUriInput,
  });

  if (!clientIdInput) {
    console.error("clientId input is missing from DOM");
  }
  if (!clientSecretInput) {
    console.error("clientSecret input is missing from DOM");
  }

  const values = {
    client_id: clientIdInput ? clientIdInput.value.trim() : "",
    client_secret: clientSecretInput ? clientSecretInput.value.trim() : "",
    redirect_uri: redirectUriInput ? redirectUriInput.value.trim() : "",
  };
  return values;
}
