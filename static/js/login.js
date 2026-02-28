const BASE = "http://127.0.0.1:8000";

async function login() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const btn = document.getElementById("login-btn");

    if (!username || !password) {
        showMessage("Both fields are required.", "error");
        return;
    }

    btn.disabled = true;
    btn.textContent = "Signing in...";

    try {
        const res = await fetch(`${BASE}/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (res.ok) {
            sessionStorage.setItem("user_id", data.user_id);
            sessionStorage.setItem("username", data.username);
            showMessage(`Welcome back, ${data.username}! Redirecting...`, "success");
            setTimeout(() => window.location.href = "/", 1500);
        } else {
            showMessage(data.detail || "Login failed.", "error");
            btn.disabled = false;
            btn.textContent = "Sign In →";
        }
    } catch (e) {
        showMessage("Could not connect to server.", "error");
        btn.disabled = false;
        btn.textContent = "Sign In →";
    }
}

function showMessage(text, type) {
    const msg = document.getElementById("message");
    msg.textContent = text;
    msg.className = `message ${type}`;
}

document.addEventListener("keydown", e => {
    if (e.key === "Enter") login();
});
