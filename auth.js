(function () {
  const path = window.location.pathname;
  const namespace = path.startsWith("/eesweb/") ? "/eesweb" : path.startsWith("/shelar/") ? "/shelar" : "";
  const apiBase = `${namespace}/api/auth`;
  const dashboardUrl = `${namespace}/dashboard.html`;
  const loginUrl = `${namespace}/login.html`;

  const loginForm = document.getElementById("loginForm");
  const resetForm = document.getElementById("resetPasswordForm");
  const forgotPasswordButton = document.getElementById("forgotPasswordButton");
  const statusElement = document.getElementById("authStatus");

  document.addEventListener("DOMContentLoaded", initialize);

  async function initialize() {
    if (loginForm) {
      loginForm.addEventListener("submit", handleLogin);
      if (forgotPasswordButton) forgotPasswordButton.addEventListener("click", handleForgotPassword);
      await redirectIfAuthenticated();
    }

    if (resetForm) {
      resetForm.addEventListener("submit", handleResetPassword);
    }
  }

  async function redirectIfAuthenticated() {
    try {
      const response = await fetch(`${apiBase}/session`, { credentials: "same-origin" });
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
      const response = await fetch(`${apiBase}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await readJsonSafe(response);
      if (!response.ok) throw new Error(data.error || "Could not sign in.");
      window.location.replace(dashboardUrl);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function handleForgotPassword() {
    const email = document.getElementById("emailInput").value.trim();
    if (!email) {
      setStatus("Enter your email address first.", true);
      return;
    }

    setStatus("Preparing reset email...");

    try {
      const response = await fetch(`${apiBase}/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email }),
      });
      const data = await readJsonSafe(response);
      if (!response.ok) throw new Error(data.error || "Could not start password reset.");
      if (data.debugResetUrl) {
        setStatus(`Reset link ready for local testing: ${data.debugResetUrl}`);
        return;
      }
      setStatus("Password reset instructions have been sent.");
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function handleResetPassword(event) {
    event.preventDefault();

    const token = new URLSearchParams(window.location.search).get("token");
    const password = document.getElementById("newPasswordInput").value;
    const confirmPassword = document.getElementById("confirmPasswordInput").value;

    if (!token) {
      setStatus("Reset link is missing or invalid.", true);
      return;
    }

    if (!password || password.length < 8) {
      setStatus("Use at least 8 characters for the new password.", true);
      return;
    }

    if (password !== confirmPassword) {
      setStatus("Passwords do not match.", true);
      return;
    }

    setStatus("Updating password...");

    try {
      const response = await fetch(`${apiBase}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token, password }),
      });
      const data = await readJsonSafe(response);
      if (!response.ok) throw new Error(data.error || "Could not reset password.");
      setStatus("Password updated. Redirecting to login...");
      window.setTimeout(() => {
        window.location.replace(loginUrl);
      }, 1200);
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
