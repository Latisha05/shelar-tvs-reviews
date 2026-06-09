(function () {
  const path = window.location.pathname;
  const namespace = path.startsWith("/eesweb/") ? "/eesweb" : path.startsWith("/shelar/") ? "/shelar" : "";
  const apiBase = "/api/events";
  const dashboardUrl = `${namespace}/dashboard.html`;
  const loginUrl = `${namespace}/login.html`;

  const loginForm = document.getElementById("loginForm");
  const statusElement = document.getElementById("authStatus");

  document.addEventListener("DOMContentLoaded", initialize);

  async function initialize() {
    if (loginForm) {
      loginForm.addEventListener("submit", handleLogin);
      await redirectIfAuthenticated();
    }
  }

  async function redirectIfAuthenticated() {
    try {
      const response = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "session" }),
      });
      if (!response.ok) return;
      const data = await readJsonSafe(response);
      if (data.authenticated) {
        window.location.replace(dashboardUrl);
      }
    } catch {
      // Ignore session lookup failures here.
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setStatus("Signing in...");

    const payload = {
      email: document.getElementById("emailInput").value.trim(),
      password: document.getElementById("passwordInput").value,
    };

    try {
      const response = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "login", ...payload }),
      });
      const data = await readJsonSafe(response);
      if (!response.ok) throw new Error(data.error || "Could not sign in.");
      window.location.replace(dashboardUrl);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function setStatus(message, isError) {
    if (!statusElement) return;
    statusElement.textContent = message || "";
    statusElement.classList.toggle("is-error", Boolean(isError));
  }

  async function readJsonSafe(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
})();
