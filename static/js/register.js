const BASE = "http://127.0.0.1:8000";

async function register() {
    const username = document.getElementById("username").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const btn = document.getElementById("register-btn");

    if (!username || !email || !password) {
        showMessage("All fields are required.", "error");
        return;
    }

    btn.disabled = true;
    btn.textContent = "Creating account...";

    try {
        const res = await fetch(`${BASE}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, email, password })
        });

        const data = await res.json();

        if (res.ok) {
            showMessage(`Account created! Welcome, ${username}. Redirecting to login...`, "success");
            setTimeout(() => window.location.href = "/login.html", 2000);
        } else {
            showMessage(data.detail || "Registration failed.", "error");
            btn.disabled = false;
            btn.textContent = "Create Account →";
        }
    } catch (e) {
        showMessage("Could not connect to server.", "error");
        btn.disabled = false;
        btn.textContent = "Create Account →";
    }
}

function showMessage(text, type) {
    const msg = document.getElementById("message");
    msg.textContent = text;
    msg.className = `message ${type}`;
}

document.addEventListener("keydown", e => {
    if (e.key === "Enter") register();
});
