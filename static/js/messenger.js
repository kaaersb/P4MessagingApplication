const BASE = "http://127.0.0.1:8000";
const userId = sessionStorage.getItem("user_id");
const username = sessionStorage.getItem("username");
const isLoggedIn = userId && username;

let activeFriendId = null;
let activeFriendName = null;
let pollInterval = null;
let notifOpen = false;

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
    renderNav();
    const appBody = document.getElementById("app-body");

    if (isLoggedIn) {
        renderMessenger(appBody);
        loadFriends();
        loadPendingRequests();
        pollInterval = setInterval(() => {
            loadPendingRequests();
            loadFriends();
            if (activeFriendId) loadMessages(activeFriendId, false);
        }, 5000);
    } else {
        renderHero(appBody);
    }

    // Close notif dropdown on outside click
    document.addEventListener("click", e => {
        const dropdown = document.getElementById("notif-dropdown");
        const btn = document.getElementById("notif-btn");
        if (notifOpen && dropdown && !dropdown.contains(e.target) && btn && !btn.contains(e.target)) {
            notifOpen = false;
            dropdown.classList.remove("open");
        }
    });

    // Close modal on overlay click
    const modal = document.getElementById("add-modal");
    if (modal) {
        modal.addEventListener("click", e => {
            if (e.target === modal) closeModal();
        });
    }
});

// ===== NAV =====
function renderNav() {
    const navRight = document.getElementById("nav-right");
    if (!navRight) return;

    if (isLoggedIn) {
        navRight.innerHTML = `
            <div class="user-chip"><div class="online-dot"></div>${username}</div>
            <button class="notif-btn" id="notif-btn" onclick="toggleNotif(event)">
                🔔
                <span class="notif-badge" id="notif-badge"></span>
            </button>
            <button class="nav-btn" onclick="logout()">Sign Out</button>
        `;
    } else {
        navRight.innerHTML = `
            <a href="/login.html" class="nav-btn" style="color:var(--text)">Sign In</a>
            <a href="/register.html" class="nav-btn" style="background:var(--accent);color:#0a0a0a;border-color:var(--accent)">Register</a>
        `;
    }
}

// ===== HERO =====
function renderHero(container) {
    container.innerHTML = `
        <div class="hero">
            <div class="hero-tag">Private Messaging Network</div>
            <h1>Send.<br><span>Connect.</span><br>Message.</h1>
            <p>A simple, direct messenger. Sign in to start conversations with people on the network.</p>
            <div class="hero-actions">
                <a href="/register.html" class="btn-large primary">Get Started →</a>
                <a href="/login.html" class="btn-large secondary">Sign In</a>
            </div>
        </div>
    `;
}

// ===== MESSENGER LAYOUT =====
function renderMessenger(container) {
    container.innerHTML = `
        <div class="sidebar">
            <div class="sidebar-header">
                <span class="sidebar-title">Messages</span>
                <button class="add-friend-btn" onclick="openModal()" title="Add Friend">+</button>
            </div>
            <div class="friends-list" id="friends-list">
                <div class="empty-friends">Loading...</div>
            </div>
        </div>
        <div class="chat-panel" id="chat-panel">
            <div class="chat-empty">
                <div class="big-icon">💬</div>
                <h3>Select a conversation</h3>
                <p>Choose a friend from the sidebar,<br>or press <strong style="color:var(--accent)">+</strong> to add someone new.</p>
            </div>
        </div>
    `;
}

// ===== LOAD FRIENDS =====
async function loadFriends() {
    try {
        const res = await fetch(`${BASE}/friends/${userId}`);
        const data = await res.json();
        const list = document.getElementById("friends-list");
        if (!list) return;

        if (data.friends.length === 0) {
            list.innerHTML = `<div class="empty-friends">No friends yet.<br>Press <strong style="color:var(--accent)">+</strong> to add someone.</div>`;
            return;
        }

        list.innerHTML = data.friends.map(f => `
            <div class="friend-card ${activeFriendId == f.id ? 'active' : ''}"
                 id="fc-${f.id}" onclick="openChat(${f.id}, '${f.username}')">
                <div class="friend-avatar">${f.username[0].toUpperCase()}</div>
                <div class="friend-info">
                    <div class="friend-name">${f.username}</div>
                    <div class="friend-last-msg">${f.last_message ? f.last_message : 'No messages yet'}</div>
                </div>
            </div>
        `).join('');
    } catch(e) { console.error(e); }
}

// ===== OPEN CHAT =====
function openChat(friendId, friendName) {
    activeFriendId = friendId;
    activeFriendName = friendName;

    document.querySelectorAll('.friend-card').forEach(c => c.classList.remove('active'));
    const card = document.getElementById(`fc-${friendId}`);
    if (card) card.classList.add('active');

    const panel = document.getElementById("chat-panel");
    panel.innerHTML = `
        <div class="chat-header">
            <div class="chat-header-avatar">${friendName[0].toUpperCase()}</div>
            <div class="chat-header-name">${friendName}</div>
        </div>
        <div class="messages-area" id="messages-area"></div>
        <div class="chat-input-bar">
            <input class="chat-input" id="msg-input" placeholder="Message ${friendName}..."
                onkeydown="if(event.key==='Enter'){event.preventDefault();sendMessage();}" />
            <button class="send-btn" onclick="sendMessage()">Send →</button>
        </div>
    `;

    loadMessages(friendId, true);
}

// ===== LOAD MESSAGES =====
async function loadMessages(friendId, scrollToBottom) {
    try {
        const res = await fetch(`${BASE}/messages/${userId}/${friendId}`);
        const data = await res.json();
        const area = document.getElementById("messages-area");
        if (!area) return;

        if (data.messages.length === 0) {
            area.innerHTML = `<div style="color:var(--muted);font-size:0.78rem;text-align:center;margin-top:60px">No messages yet — say hello! 👋</div>`;
            return;
        }

        const wasAtBottom = area.scrollHeight - area.clientHeight - area.scrollTop < 40;

        area.innerHTML = data.messages.map(m => {
            const isSent = m.sender_id == userId;
            const time = new Date(m.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            return `
                <div class="msg-row ${isSent ? 'sent' : 'received'}">
                    <div class="msg-bubble">
                        ${m.content}
                        <div class="msg-time">${time}</div>
                    </div>
                </div>
            `;
        }).join('');

        if (scrollToBottom || wasAtBottom) area.scrollTop = area.scrollHeight;
    } catch(e) { console.error(e); }
}

// ===== SEND MESSAGE =====
async function sendMessage() {
    const input = document.getElementById("msg-input");
    if (!input) return;
    const content = input.value.trim();
    if (!content || !activeFriendId) return;
    input.value = '';

    try {
        await fetch(`${BASE}/send-message`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                sender_id: parseInt(userId),
                receiver_id: activeFriendId,
                content
            })
        });
        loadMessages(activeFriendId, true);
        loadFriends();
    } catch(e) { console.error(e); }
}

// ===== PENDING REQUESTS =====
async function loadPendingRequests() {
    try {
        const res = await fetch(`${BASE}/pending-requests/${userId}`);
        const data = await res.json();
        const badge = document.getElementById("notif-badge");
        const list = document.getElementById("notif-list");
        if (!badge) return;

        if (data.requests.length === 0) {
            badge.style.display = 'none';
            if (list) list.innerHTML = `<div class="notif-empty">No pending requests</div>`;
        } else {
            badge.style.display = 'flex';
            badge.textContent = data.requests.length;
            if (list) {
                list.innerHTML = data.requests.map(r => `
                    <div class="notif-item">
                        <div>
                            <div class="notif-name">${r.username}</div>
                            <div class="notif-sub">wants to be friends</div>
                        </div>
                        <div class="notif-actions">
                            <button class="notif-accept" onclick="respondRequest(${r.request_id}, 'accept')">✓ Accept</button>
                            <button class="notif-decline" onclick="respondRequest(${r.request_id}, 'decline')">✕</button>
                        </div>
                    </div>
                `).join('');
            }
        }
    } catch(e) {}
}

async function respondRequest(requestId, action) {
    try {
        await fetch(`${BASE}/friend-request/respond`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ request_id: requestId, action })
        });
        loadPendingRequests();
        loadFriends();
    } catch(e) {}
}

// ===== NOTIFICATION TOGGLE =====
function toggleNotif(e) {
    e.stopPropagation();
    notifOpen = !notifOpen;
    document.getElementById("notif-dropdown").classList.toggle("open", notifOpen);
}

// ===== ADD FRIEND MODAL =====
function openModal() {
    document.getElementById("add-modal").classList.add("open");
    setTimeout(() => document.getElementById("search-input").focus(), 50);
}

function closeModal() {
    document.getElementById("add-modal").classList.remove("open");
    document.getElementById("search-input").value = '';
    document.getElementById("search-results").innerHTML = '';
    const msg = document.getElementById("modal-message");
    msg.className = 'modal-message';
    msg.textContent = '';
}

let searchTimeout;
function searchUsers() {
    const query = document.getElementById("search-input").value.trim();
    const results = document.getElementById("search-results");
    if (query.length < 1) { results.innerHTML = ''; return; }

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`${BASE}/users`);
            const data = await res.json();
            const filtered = data.users.filter(u =>
                u.username.toLowerCase().includes(query.toLowerCase()) && u.id != userId
            );

            if (filtered.length === 0) {
                results.innerHTML = `<div style="font-size:0.75rem;color:var(--muted);padding:8px 0">No users found</div>`;
                return;
            }

            results.innerHTML = filtered.map(u => `
                <div class="search-result-item">
                    <div>
                        <div class="search-result-name">${u.username}</div>
                        <div class="search-result-id">ID: ${u.id}</div>
                    </div>
                    <button class="add-btn" id="add-btn-${u.id}" onclick="sendFriendRequest(${u.id}, '${u.username}')">Add</button>
                </div>
            `).join('');
        } catch(e) {}
    }, 300);
}

async function sendFriendRequest(receiverId, receiverName) {
    const btn = document.getElementById(`add-btn-${receiverId}`);
    if (btn) { btn.disabled = true; btn.textContent = '...'; }

    try {
        const res = await fetch(`${BASE}/friend-request`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requester_id: parseInt(userId), receiver_id: receiverId })
        });
        const data = await res.json();
        const msg = document.getElementById("modal-message");

        if (res.ok) {
            msg.textContent = `Request sent to ${receiverName}!`;
            msg.className = 'modal-message success';
            if (btn) btn.textContent = 'Sent ✓';
        } else {
            msg.textContent = data.detail || 'Could not send request.';
            msg.className = 'modal-message error';
            if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
        }
    } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
    }
}

// ===== LOGOUT =====
function logout() {
    clearInterval(pollInterval);
    sessionStorage.removeItem("user_id");
    sessionStorage.removeItem("username");
    window.location.reload();
}
