export function getBouncieFormValues() {
  const clientIdInput = document.getElementById("clientId");
  const clientSecretInput = document.getElementById("clientSecret");
  const redirectUriInput = document.getElementById("redirectUri");

  return {
    client_id: clientIdInput ? clientIdInput.value.trim() : "",
    client_secret: clientSecretInput ? clientSecretInput.value.trim() : "",
    redirect_uri: redirectUriInput ? redirectUriInput.value.trim() : "",
  };
}
