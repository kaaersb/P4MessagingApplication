// =============================================================================
// STATE
// =============================================================================
// Central application state. Mutated in-place throughout the app.
// ws, wsReconnectTimer, and heartbeatInterval are managed together — always
// clean them up via disconnectWebSocket() rather than touching them directly.
const state = {
    currentUser: null,       // { id, username } — set on login, cleared on logout
    friends: [],
    pendingRequests: [],
    activeFriendId: null,        // the friend whose conversation is currently open
    activeFriendshipId: null,    // used by block/unfriend endpoints
    messages: [],                // messages for the active conversation only
    infoPanelOpen: false,
    currentTab: 'friends',       // 'friends' | 'requests'
    ws: null,
    wsReconnectTimer: null,
    heartbeatInterval: null,
    fallbackPollInterval: null,
};


// =============================================================================
// API HELPERS
// =============================================================================
// Thin wrappers around fetch that:
//   1. Automatically serialise/parse JSON.
//   2. Throw an Error (with the server's detail message) on non-2xx responses,
//      so callers can use a simple try/catch rather than checking r.ok themselves.
const api = {
    async post(url, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) {
            const detail = data.detail;
            if (Array.isArray(detail)) {
                throw new Error(detail.map(e => e.msg).join(', '));
            }
            throw new Error(detail || 'Request failed');
            }
        return data;
    },
    async get(url) {
        const r = await fetch(url);
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'Request failed');
        return data;
    },
    async put(url, body) {
        const r = await fetch(url, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'Request failed');
        return data;
    },
    async delete(url, body) {
        const r = await fetch(url, {
            method: 'DELETE',
            // Only set Content-Type when there is a body; DELETE requests
            // without a body should not advertise JSON to avoid CORS preflight.
            headers: body ? {'Content-Type': 'application/json'} : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail || 'Request failed');
        return data;
    },
};


// =============================================================================
// TOAST
// =============================================================================
// Appends a self-removing notification to #toast-container.
// `type` maps to a CSS class: 'info' | 'success' | 'error'.
function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toast-container').appendChild(el);
    // Add a CSS fade-out class shortly before removing the element so the
    // transition plays fully before the node disappears from the DOM.
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 300);
    }, 3200);
}


// =============================================================================
// UTILITIES
// =============================================================================
// Returns the first two characters of a name in uppercase, used for avatar
// placeholder text when no profile picture is available.
function initials(name) {
    return name ? name.slice(0, 2).toUpperCase() : '??';
}

// Short HH:MM time string for message timestamps inside the chat view.
function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

// Groups messages into sections by day ("Today", "Yesterday", or a short date).
function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const diff = today - d;
    if (diff < 86400000 && d.getDate() === today.getDate()) return 'Today';
    if (diff < 172800000) return 'Yesterday';
    return d.toLocaleDateString([], {month: 'short', day: 'numeric'});
}

// Compact timestamp for the contact list sidebar preview:
//   - Same day    → HH:MM
//   - This week   → weekday abbreviation (Mon, Tue…)
//   - Older       → short date (Jan 5)
function fmtPreviewTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date();
    const diff = today - d;
    if (diff < 86400000 && d.getDate() === today.getDate())
        return d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    if (diff < 604800000)
        return d.toLocaleDateString([], {weekday: 'short'});
    return d.toLocaleDateString([], {month: 'short', day: 'numeric'});
}


// =============================================================================
// AUTH FLOW
// =============================================================================
// Toggles visibility between the three pre-rendered auth screens
// (welcome / login / register) without any page navigation.
function showView(view) {
    ['welcome-view', 'login-view', 'register-view'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.toggle('hidden', id !== `${view}-view`);
    });
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('lg-username').value.trim();
    const password = document.getElementById('lg-password').value.trim();
    if (!username || !password) return;

    setLoading('login', true);
    try {
        const data = await api.post('/login', {username, password});
        state.currentUser = {id: data.user_id, username: data.username};
        enterApp();
        toast(`Welcome back, ${data.username}!`, 'success');
    } catch (err) {
        // Surface the server's validation message inline rather than as a toast
        // so the user can see which field is at fault without dismissing a popup.
        showFieldError('lg-username-group', 'lg-username-error', err.message);
    } finally {
        setLoading('login', false);
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('rg-username').value.trim();
    const email = document.getElementById('rg-email').value.trim();
    const password = document.getElementById('rg-password').value;
    if (!username || !email || !password) return;

    setLoading('register', true);
    try {
        await api.post('/register', {username, email, password});
        toast('Account created! Please sign in.', 'success');
        // Pre-fill the username field so the user doesn't have to retype it.
        showView('login');
        document.getElementById('lg-username').value = username;
    } catch (err) {
        // FastAPI 422 errors have a nested structure
        const msg = err.message || 'Registration failed';
        showFieldError('rg-username-group', 'rg-username-error', msg);
    } finally {x$
        setLoading('register', false);
    }
}

// Swaps the button label for a spinner while a request is in flight to give
// the user immediate feedback and prevent accidental double-submission.
function setLoading(form, loading) {
    document.getElementById(`${form}-btn-text`).classList.toggle('hidden', loading);
    document.getElementById(`${form}-btn-spinner`).classList.toggle('hidden', !loading);
    document.getElementById(`${form}-btn`).disabled = loading;
}

// Adds an error class to the input group (triggers red border via CSS) and
// shows an inline message below it, then removes both after 4 seconds.
function showFieldError(groupId, errorId, msg) {
    document.getElementById(groupId).classList.add('has-error');
    document.getElementById(errorId).textContent = msg;
    setTimeout(() => document.getElementById(groupId).classList.remove('has-error'), 4000);
}

async function handleLogout() {
    // Tear down real-time connections before clearing state so no stale
    // push events can arrive after we've nuked the user session.
    disconnectWebSocket();
    stopFallbackPoll();

    // Invalidate the server-side session and clear the HttpOnly cookie.
    try { await api.post('/logout', {}); } catch (_) { /* ignore */ }

    state.currentUser = null;
    state.activeFriendId = null;
    state.activeFriendshipId = null;
    state.messages = [];
    state.friends = [];
    state.pendingRequests = [];

    // ── Reset chat area to its blank initial state ──
    const activeChat = document.getElementById('active-chat');
    activeChat.classList.add('hidden');
    activeChat.style.display = 'none';
    document.getElementById('chat-empty').classList.remove('hidden');
    document.getElementById('messages-container').innerHTML = '';

    // ── Reset sidebar ──
    document.getElementById('contact-list').innerHTML = '';
    document.getElementById('contact-search').value = '';
    const badge = document.getElementById('req-count-badge');
    badge.style.display = 'none';
    badge.textContent = '';
    document.getElementById('nav-unread-badge').classList.add('hidden');

    // ── Close info panel if open ──
    if (state.infoPanelOpen) {
        state.infoPanelOpen = false;
        document.getElementById('info-panel').classList.remove('open');
    }

    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    showView('welcome');
    toast('You have been signed out.', 'info');
}


// =============================================================================
// APPLICATION ENTRY
// =============================================================================
// Called once the user has successfully authenticated. Sets up the UI,
// bootstraps data, and opens the WebSocket channel.
function enterApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');

    // Render the current user's initials in the nav avatar slot.
    const navAvatarWrap = document.getElementById('nav-user-avatar');
    navAvatarWrap.innerHTML = `<div class="avatar size-sm online" title="${state.currentUser.username}">${initials(state.currentUser.username)}</div>`;

    loadFriends();
    loadPendingRequests();
    connectWebSocket();
    startFallbackPoll(); // belt-and-suspenders polling in case WS drops

    // Request permission for browser notifications when the user enters
    // the app so we can display notifications for incoming messages.
    requestNotificationPermission();
}


// =============================================================================
// WEBSOCKET — real-time push
// =============================================================================

/**
 * Open (or re-open) the WebSocket connection for the current user.
 * Handles heartbeats and automatic reconnection on unexpected close.
 */
function connectWebSocket() {
    // Always clean up any existing connection first to avoid duplicate sockets.
    disconnectWebSocket();

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${location.host}/ws/${state.currentUser.id}`);
    state.ws = ws;

    ws.onopen = () => {
        console.debug('[WS] Connected');
        // Send a heartbeat ping every 25 s to keep the connection alive
        // through load-balancers / proxies that close idle sockets.
        state.heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, 25000);
        // Catch up on any messages that arrived while the socket was down.
        if (state.activeFriendId) loadMessages(true).catch(() => {});
    };

    ws.onmessage = (event) => {
        if (event.data === 'pong') return; // heartbeat reply — ignore
        try {
            const payload = JSON.parse(event.data);
            console.debug('[WS] received payload', payload);
            handleServerPush(payload);
        } catch (err) {
            console.warn('[WS] Could not parse message:', event.data);
        }
    };

    ws.onerror = (err) => {
        console.warn('[WS] Error:', err);
    };

    ws.onclose = (event) => {
        console.debug('[WS] Closed — code:', event.code);
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = null;

        // Don't reconnect if the user deliberately logged out (code 1000)
        // or if there is no longer a logged-in user.
        if (!state.currentUser || event.code === 1000) return;

        // Exponential-ish back-off capped at 5 s to avoid hammering the server.
        const delay = Math.min(5000, 1000 + Math.random() * 2000);
        state.wsReconnectTimer = setTimeout(connectWebSocket, delay);
    };
}

// Tears down the WebSocket and all associated timers cleanly.
// Nulling out ws.onclose before calling ws.close() prevents the auto-reconnect
// logic from firing during an intentional disconnect (e.g. logout).
function disconnectWebSocket() {
    clearTimeout(state.wsReconnectTimer);
    clearInterval(state.heartbeatInterval);
    state.wsReconnectTimer = null;
    state.heartbeatInterval = null;

    if (state.ws) {
        state.ws.onclose = null; // prevent auto-reconnect on intentional close
        state.ws.close(1000, 'logout');
        state.ws = null;
    }
}


// =============================================================================
// BROWSER NOTIFICATIONS
// =============================================================================

// Ask the user for permission to show notifications. Safe to call multiple
// times; the browser will only prompt on the first request.
function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            console.debug('[NOTIF] permission', permission);
        });
    }
}

// Open a conversation by friend id. If the friend isn't present in state.friends
// we reload the list and then open it.
async function openConversationById(friendId) {
    let friend = state.friends.find(f => Number(f.id) === Number(friendId));
    if (!friend) {
        try {
            await loadFriends(true);
            friend = state.friends.find(f => Number(f.id) === Number(friendId));
        } catch (e) {
            // ignore
        }
    }
    if (friend) openConversation(friend);
}

// Display a browser notification for certain server-push payloads.
function showBrowserNotification(payload) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!state.currentUser) return;

    let title = 'Notification';
    let body = '';
    let tag = undefined;
    let clickTargetId = null;

    switch (payload.type) {
        case 'new_message': {
            const msg = payload.message || {};
            const senderId = Number(msg.sender_id);
            const sender = state.friends.find(f => Number(f.id) === senderId);
            const senderName = sender ? sender.username : 'Someone';
            title = senderName;
            body = msg.content || 'Sent you a message';
            tag = `msg-${msg.id}`;
            clickTargetId = senderId;

            // Only notify if the user isn't actively viewing that conversation
            if (Number(state.activeFriendId) === senderId && !document.hidden) return;
            break;
        }
        case 'friend_request': {
            title = 'Friend request';
            body = 'You have a new friend request';
            tag = 'friend-request';
            break;
        }
        case 'friend_accepted': {
            title = 'Friend added';
            body = 'A friend request was accepted';
            tag = 'friend-accepted';
            break;
        }
        default:
            return;
    }

    const n = new Notification(title, {body, tag});
    n.onclick = (ev) => {
        ev.preventDefault();
        window.focus();
        if (clickTargetId) openConversationById(clickTargetId);
        n.close();
    };
}

/**
 * Dispatch incoming server-push events to the right handler.
 * Each case is intentionally surgical — only the minimum DOM is touched
 * so there is no flicker or scroll-position loss during live updates.
 */
function handleServerPush(payload) {
    switch (payload.type) {

        case 'new_message': {
            const msg = payload.message;
            // Coerce IDs to numbers to avoid mismatches from stringified JSON
            const senderId = Number(msg.sender_id);
            const recipientId = Number(msg.recipient_id);
            const activeId = Number(state.activeFriendId);

            // Check whether this message belongs to the currently visible conversation.
            const isActiveConvo = (senderId === activeId) || (recipientId === activeId);

            if (isActiveConvo) {
                // Append without touching existing DOM
                appendMessage(msg);
                // Mark as read immediately since the chat is open
                markConversationRead();
            }

            // Refresh sidebar preview & unread badge regardless of active chat.
            loadFriends(true);
            // Show a browser notification when the user isn't actively viewing
            // the conversation or the page is hidden.
            try { showBrowserNotification(payload); } catch (e) { /* ignore */ }
            break;
        }

        case 'message_edited': {
            const {message_id, new_content} = payload;
            // Sync in-memory state so any subsequent full re-render is correct.
            const m = state.messages.find(m => m.id === message_id);
            if (m) {
                m.content = new_content;
                m.is_edited = true;
            }
            // Patch the bubble in-place — no full re-render
            patchBubbleContent(message_id, new_content, true);
            break;
        }

        case 'message_deleted': {
            const {message_id} = payload;
            state.messages = state.messages.filter(m => m.id !== message_id);
            const row = document.querySelector(`[data-msg-id="${message_id}"]`);
            if (row) row.remove();
            break;
        }

        case 'message_read': {
            const {message_id} = payload;
            // Keep in-memory state consistent with the DOM update below.
            const m = state.messages.find(m => m.id === message_id);
            if (m) m.is_read = true;
            markMessageReadInDOM(message_id);
            break;
        }

        case 'friend_request':
            // A new request arrived — just refresh the count badge and list.
            loadPendingRequests(true);
            try { showBrowserNotification(payload); } catch (e) { /* ignore */ }
            break;

        case 'friend_accepted':
            // Both lists change: the accepted user joins friends, request is gone.
            loadFriends(true);
            loadPendingRequests(true);
            try { showBrowserNotification(payload); } catch (e) { /* ignore */ }
            break;

        default:
            console.debug('[WS] Unknown payload type:', payload.type);
    }
}


// =============================================================================
// FALLBACK POLL — lightweight sidebar refresh only, no message re-render
// =============================================================================

/**
 * Silently fetch the active conversation and append any messages that aren't
 * already rendered. This is a no-flicker fallback for when the WebSocket push
 * is missed (e.g. brief disconnection or proxy not forwarding upgrades).
 */
async function silentPollMessages() {
    if (!state.currentUser || !state.activeFriendId) return;
    try {
        const data = await api.get(`/messages/${state.currentUser.id}/${state.activeFriendId}`);
        const fresh = data.messages || [];
        const knownIds = new Set(state.messages.map(m => m.id));
        fresh.filter(m => !knownIds.has(m.id)).forEach(msg => appendMessage(msg));
    } catch (_) { /* ignore transient errors */ }
}

/**
 * Keep the sidebar and active conversation in sync even if the WebSocket
 * drops momentarily. Everything is polled on the same 3 s cadence as
 * messages so friend requests and acceptances refresh just as promptly.
 */
function startFallbackPoll() {
    stopFallbackPoll();
    state.fallbackPollInterval = setInterval(async () => {
        if (!state.currentUser) return;
        await silentPollMessages();
        await loadFriends(true);
        await loadPendingRequests(true);
    }, 3000);
}

function stopFallbackPoll() {
    if (state.fallbackPollInterval) {
        clearInterval(state.fallbackPollInterval);
        state.fallbackPollInterval = null;
    }
}


// =============================================================================
// SIDEBAR TABS
// =============================================================================
function switchTab(tab) {
    state.currentTab = tab;
    document.getElementById('tab-friends').classList.toggle('active', tab === 'friends');
    document.getElementById('tab-requests').classList.toggle('active', tab === 'requests');
    renderContactList();
}


// =============================================================================
// FRIENDS & REQUESTS
// =============================================================================

// `silent = true` suppresses the error toast — used by background refreshes
// (WebSocket events, fallback poll) where a transient failure shouldn't
// interrupt the user.
async function loadFriends(silent = false) {
    try {
        const data = await api.get(`/friends/${state.currentUser.id}`);
        state.friends = data.friends || [];
        if (state.currentTab === 'friends') renderContactList();
        updateUnreadBadge();
    } catch (err) {
        if (!silent) toast('Failed to load friends', 'error');
    }
}

async function loadPendingRequests(silent = false) {
    try {
        const data = await api.get(`/pending-requests/${state.currentUser.id}`);
        state.pendingRequests = data.requests || [];
        const count = state.pendingRequests.length;
        const badge = document.getElementById('req-count-badge');
        badge.style.display = count > 0 ? 'inline' : 'none';
        badge.textContent = count > 0 ? ` (${count})` : '';
        if (state.currentTab === 'requests') renderContactList();
    } catch (err) {
        if (!silent) toast('Failed to load requests', 'error');
    }
}

// Aggregates all per-friend unread counts and reflects the total in the
// global nav badge (shown as "99+" when the number is very large).
function updateUnreadBadge() {
    const total = state.friends.reduce((sum, f) => sum + (f.unread_count || 0), 0);
    const badge = document.getElementById('nav-unread-badge');
    if (total > 0) {
        badge.textContent = total > 99 ? '99+' : total;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}


// =============================================================================
// CONTACT LIST RENDERING
// =============================================================================

// Full sidebar re-render. Called after data loads or the active tab changes.
// Uses an optional `searchQuery` to filter the friends list client-side.
function renderContactList(searchQuery = '') {
    const list = document.getElementById('contact-list');
    list.innerHTML = '';

    if (state.currentTab === 'requests') {
        renderRequestsList(list);
        return;
    }

    let friends = state.friends;
    if (searchQuery) {
        friends = friends.filter(f =>
            f.username.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }

    if (friends.length === 0) {
        list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <p>${searchQuery ? 'No friends match your search.' : 'No friends yet.<br/>Add someone to get started.'}</p>
      </div>`;
        return;
    }

    friends.forEach(friend => {
        const item = document.createElement('div');
        item.className = `contact-item${friend.id === state.activeFriendId ? ' active' : ''}`;
        item.setAttribute('role', 'listitem');
        item.onclick = () => openConversation(friend);
        item.innerHTML = `
      <div class="avatar size-md">${initials(friend.username)}</div>
      <div class="contact-info">
        <div class="contact-name">${friend.username}</div>
        <div class="contact-preview">${friend.last_message ? friend.last_message : '<em style="opacity:.5">No messages yet</em>'}</div>
      </div>
      <div class="contact-meta">
        ${friend.last_message_time ? `<span class="contact-time">${fmtPreviewTime(friend.last_message_time)}</span>` : ''}
        ${friend.unread_count > 0 ? `<span class="contact-badge">${friend.unread_count}</span>` : ''}
      </div>`;
        list.appendChild(item);
    });
}

function renderRequestsList(list) {
    if (state.pendingRequests.length === 0) {
        list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.1a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.22h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.09 6.09l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21.73 17.5z"/></svg>
        </div>
        <p>No pending friend requests.</p>
      </div>`;
        return;
    }

    state.pendingRequests.forEach(req => {
        const item = document.createElement('div');
        item.className = 'request-item';
        item.innerHTML = `
      <div class="avatar size-md">${initials(req.username)}</div>
      <div class="contact-info">
        <div class="contact-name">${req.username}</div>
        <div class="contact-preview">wants to connect</div>
      </div>
      <div class="request-actions">
        <button class="req-btn accept" title="Accept" data-action="accept" data-request-id="${req.request_id}">✓</button>
        <button class="req-btn decline" title="Decline" data-action="decline" data-request-id="${req.request_id}">✕</button>
      </div>`;
        list.appendChild(item);
    });
}

// Called on every keystroke in the search box; re-renders with the current value.
function handleContactSearch(val) {
    renderContactList(val.trim());
}


// =============================================================================
// CONVERSATION
// =============================================================================
async function openConversation(friend) {
    state.activeFriendId = friend.id;
    state.activeFriendshipId = friend.friendship_id;

    // Re-render the contact list so the newly active item gets its highlight.
    renderContactList(document.getElementById('contact-search').value);

    // Populate the chat header and info panel with this friend's details.
    document.getElementById('chat-header-avatar').textContent = initials(friend.username);
    document.getElementById('chat-header-name').textContent = friend.username;
    document.getElementById('info-avatar').textContent = initials(friend.username);
    document.getElementById('info-name').textContent = friend.username;
    document.getElementById('info-email').textContent = '';

    // Fetch the full user record in the background to fill in the email field.
    // We don't await this — the rest of the conversation can load immediately.
    api.get(`/users/${friend.id}`)
        .then(u => {
            document.getElementById('info-email').textContent = u.email || '';
        })
        .catch(() => {
        });

    document.getElementById('chat-empty').classList.add('hidden');
    const activeChat = document.getElementById('active-chat');
    activeChat.classList.remove('hidden');
    activeChat.style.display = 'flex';

    // On mobile, close the sidebar overlay so the chat is fully visible.
    closeSidebar();

    // Full load on conversation open — clears old messages and fetches fresh.
    await loadMessages();

    document.getElementById('chat-input').focus();
}


// =============================================================================
// MESSAGES — load / render / append
// =============================================================================

/**
 * Full message load — called once when opening a conversation.
 * Rebuilds the message list from scratch (intentional here — the user
 * just switched conversations so a full render is correct).
 */
async function loadMessages(silent = false) {
    if (!state.activeFriendId) return;
    try {
        const data = await api.get(`/messages/${state.currentUser.id}/${state.activeFriendId}`);
        state.messages = data.messages || [];
        renderMessages();
        // Refreshing the friend list here clears the unread badge for this
        // conversation, since the server marks messages as read on GET /messages.
        if (!silent) loadFriends(true);
    } catch (err) {
        if (!silent) toast('Failed to load messages', 'error');
    }
}

/**
 * Full re-render — only called when opening a conversation or after an edit/
 * delete that requires layout recalculation.  NOT called during live updates.
 *
 * Inserts date dividers whenever the calendar day changes between consecutive
 * messages, then scrolls to the bottom.
 */
function renderMessages() {
    const container = document.getElementById('messages-container');
    if (!container) return;

    container.innerHTML = '';

    if (state.messages.length === 0) {
        container.innerHTML = `
      <div class="empty-state" style="flex:1;padding-top:60px;">
        <div class="empty-state-icon">💬</div>
        <p>Start the conversation!</p>
      </div>`;
        return;
    }

    let lastDate = null;
    state.messages.forEach(msg => {
        const msgDate = fmtDate(msg.sent_at);
        if (msgDate !== lastDate) {
            lastDate = msgDate;
            container.appendChild(makeDateDivider(msgDate));
        }
        container.appendChild(createMsgElement(msg));
    });

    container.scrollTop = container.scrollHeight;
}

/**
 * Append a single new message node without touching existing DOM.
 * This is what the WebSocket push calls — no flicker, no scroll jump.
 *
 * Only auto-scrolls to the new message if the user was already near the bottom
 * (within 100px). This way a user reading old messages isn't jumped away.
 */
function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    // Guard: message already rendered (can happen if WS and fallback race)
    if (container.querySelector(`[data-msg-id="${msg.id}"]`)) return;

    // Remove "Start the conversation!" placeholder if present
    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    // Insert a date divider if this message falls on a new day
    const msgDate = fmtDate(msg.sent_at);
    const lastDivider = container.querySelector('.date-divider:last-of-type');
    const lastDividerText = lastDivider
        ? lastDivider.querySelector('.date-divider-text')?.textContent
        : null;
    if (msgDate !== lastDividerText) {
        container.appendChild(makeDateDivider(msgDate));
    }

    const isNearBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight < 100;

    state.messages.push(msg);
    container.appendChild(createMsgElement(msg));

    if (isNearBottom) container.scrollTop = container.scrollHeight;
}

/**
 * Patch just the text content of an existing bubble after an edit.
 * Avoids a full re-render for a single edit to prevent scroll-position loss.
 */
function patchBubbleContent(msgId, newContent, isEdited) {
    const bubble = document.getElementById(`bubble-${msgId}`);
    if (!bubble) return;

    // Remove existing text nodes while leaving the action buttons (edit/delete)
    // in place — they are child elements, not text nodes, so this is safe.
    bubble.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) node.remove();
    });
    bubble.insertBefore(document.createTextNode(newContent), bubble.firstChild);

    // Add an "edited" label to the meta row if it isn't already there.
    const metaRow = bubble.closest('.msg-body')?.querySelector('.bubble-meta');
    if (metaRow && isEdited && !metaRow.querySelector('.bubble-edited')) {
        const editedSpan = document.createElement('span');
        editedSpan.className = 'bubble-edited';
        editedSpan.textContent = 'edited';
        metaRow.insertBefore(editedSpan, metaRow.querySelector('.read-ticks'));
    }
}

/**
 * Add a blue-tick read indicator to a message bubble without re-rendering.
 * Called when the server pushes a `message_read` event.
 */
function markMessageReadInDOM(msgId) {
    const row = document.querySelector(`[data-msg-id="${msgId}"]`);
    if (!row) return;
    const metaRow = row.querySelector('.bubble-meta');
    if (!metaRow || metaRow.querySelector('.read-ticks')) return;

    metaRow.insertAdjacentHTML('beforeend', `
        <svg class="read-ticks" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"/>
        </svg>`);
}

/**
 * Tell the server the current conversation has been read (fire-and-forget).
 * The server marks messages as read when GET /messages is called, so we only
 * need to refresh the friend list here to clear the sidebar unread badge.
 */
async function markConversationRead() {
    await loadFriends(true);
}

// --- DOM helpers ---

function makeDateDivider(dateText) {
    const divider = document.createElement('div');
    divider.className = 'date-divider';
    divider.innerHTML = `<span class="date-divider-text">${dateText}</span>`;
    return divider;
}

// Builds a single message row element from a message object.
// Outgoing messages (isSelf) get edit/delete action buttons and read ticks.
// Incoming messages get an avatar on the left.
function createMsgElement(msg) {
    const isSelf = msg.sender_id === state.currentUser.id;
    const row = document.createElement('div');
    row.className = `msg-row${isSelf ? ' self' : ''}`;
    row.dataset.msgId = msg.id;

    const friend = state.friends.find(f => f.id === msg.sender_id);
    const avatarHtml = !isSelf
        ? `<div class="msg-avatar"><div class="avatar size-sm">${initials(friend?.username || '?')}</div></div>`
        : '';

    const editBtns = isSelf ? `
    <div class="bubble-actions">
      <button class="bubble-action-btn" data-action="edit" data-msg-id="${msg.id}" title="Edit">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="bubble-action-btn del" data-action="delete" data-msg-id="${msg.id}" title="Delete">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>` : '';

    const readTick = isSelf && msg.is_read ? `
    <svg class="read-ticks" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : '';

    row.innerHTML = `
    ${avatarHtml}
    <div class="msg-body">
      <div class="bubble" id="bubble-${msg.id}">${msg.content}${editBtns}</div>
      <div class="bubble-meta">
        <span class="bubble-time">${fmtTime(msg.sent_at)}</span>
        ${msg.is_edited ? '<span class="bubble-edited">edited</span>' : ''}
        ${readTick}
      </div>
    </div>`;

    return row;
}


// =============================================================================
// SEND MESSAGE
// =============================================================================
async function sendMessage() {
    const input = document.getElementById('chat-input');
    const content = input.value.trim();
    if (!content || !state.activeFriendId) return;

    // Clear the input immediately for snappy UX — the server response will
    // push the confirmed message back via WebSocket.
    input.value = '';
    input.style.height = 'auto';
    document.getElementById('send-btn').disabled = true;

    try {
        await api.post('/send-message', {
            sender_id: state.currentUser.id,
            recipient_id: state.activeFriendId,
            content,
        });
        // The server pushes the new message back via WebSocket, so appendMessage()
        // fires automatically. If the WS is temporarily down we fall back to a
        // full reload to ensure the message appears.
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            await loadMessages(true);
        }
    } catch (err) {
        toast(err.message, 'error');
        // Restore the draft so the user doesn't lose what they typed.
        input.value = content;
    }
}

// Handles Enter-to-send (Shift+Enter inserts a newline instead) and keeps
// the send button in sync with whether the input has non-whitespace content.
function handleInputKeydown(e) {
    const btn = document.getElementById('send-btn');
    btn.disabled = !e.target.value.trim();
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

// Grows the textarea as the user types (capped at 140px) to avoid a fixed
// single-line box that hides long messages. Also syncs the send button state.
function autoResizeInput(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    document.getElementById('send-btn').disabled = !el.value.trim();
}


// =============================================================================
// EDIT & DELETE MESSAGES
// =============================================================================

// Replaces the bubble's text content with an inline edit form.
// Pressing Enter or clicking ✓ commits; Escape or ✕ calls renderMessages()
// to restore the original bubble from in-memory state.
function startEdit(msgId) {
    const msg = state.messages.find(m => m.id === msgId);
    if (!msg) return;

    const bubble = document.getElementById(`bubble-${msgId}`);
    bubble.innerHTML = `
    <div class="edit-inline">
      <input class="input-field" id="edit-input-${msgId}" value="${msg.content}" />
      <div class="edit-inline-actions">
        <button class="edit-confirm" data-action="confirm-edit" data-msg-id="${msgId}" title="Save">✓</button>
        <button class="edit-cancel"  data-action="cancel-edit"  title="Cancel">✕</button>
      </div>
    </div>`;

    const inp = document.getElementById(`edit-input-${msgId}`);
    inp.focus();
    // Position the cursor at the end of the existing text for a natural feel.
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.onkeydown = (e) => {
        if (e.key === 'Enter') confirmEdit(msgId);
        if (e.key === 'Escape') renderMessages();
    };
}

async function confirmEdit(msgId) {
    const inp = document.getElementById(`edit-input-${msgId}`);
    const newContent = inp ? inp.value.trim() : '';
    if (!newContent) return;
    try {
        await api.put(`/messages/${msgId}`, {user_id: state.currentUser.id, new_content: newContent});
        toast('Message edited', 'success');
        // The server will push a `message_edited` WS event; if WS is down,
        // update the DOM directly as a fallback.
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            const m = state.messages.find(m => m.id === msgId);
            if (m) {
                m.content = newContent;
                m.is_edited = true;
            }
            patchBubbleContent(msgId, newContent, true);
        }
    } catch (err) {
        toast(err.message, 'error');
        // On error, revert the edit form back to a normal bubble.
        renderMessages();
    }
}

async function deleteMessage(msgId) {
    try {
        await api.delete(`/messages/${msgId}?user_id=${state.currentUser.id}`);
        toast('Message deleted', 'info');
        state.messages = state.messages.filter(m => m.id !== msgId);
        // Remove the DOM node directly — no full re-render needed.
        const row = document.querySelector(`[data-msg-id="${msgId}"]`);
        if (row) row.remove();
    } catch (err) {
        toast(err.message, 'error');
    }
}


// =============================================================================
// FRIEND REQUESTS
// =============================================================================
async function respondToRequest(requestId, action) {
    try {
        await api.post('/friend-request/respond', {
            request_id: requestId,
            action,
            user_id: state.currentUser.id,
        });
        toast(
            action === 'accept' ? 'Friend request accepted!' : 'Request declined.',
            action === 'accept' ? 'success' : 'info'
        );
        // Reload both lists: the accepted user moves from requests to friends.
        await loadPendingRequests();
        await loadFriends();
    } catch (err) {
        toast(err.message, 'error');
    }
}


// =============================================================================
// ADD FRIEND MODAL
// =============================================================================
function openAddFriendModal() {
    document.getElementById('add-friend-modal').classList.remove('hidden');
    document.getElementById('modal-search-input').value = '';
    document.getElementById('modal-search-results').innerHTML = `
    <p style="color:var(--clr-text-muted);font-size:13px;text-align:center;padding:24px 0;">
      Start typing to search for users
    </p>`;
    setTimeout(() => document.getElementById('modal-search-input').focus(), 100);
}

function closeAddFriendModal() {
    document.getElementById('add-friend-modal').classList.add('hidden');
}

// Debounced search so we don't fire an API request on every single keystroke.
let modalSearchTimer;

async function handleModalSearch(val) {
    clearTimeout(modalSearchTimer);
    const results = document.getElementById('modal-search-results');
    if (!val.trim()) {
        results.innerHTML = `<p style="color:var(--clr-text-muted);font-size:13px;text-align:center;padding:24px 0;">Start typing to search for users</p>`;
        return;
    }
    results.innerHTML = `<div style="display:flex;justify-content:center;padding:20px;"><div class="spinner"></div></div>`;
    // Wait 300 ms after the last keystroke before sending the request.
    modalSearchTimer = setTimeout(async () => {
        try {
            const data = await api.get(`/users/search?query=${encodeURIComponent(val)}`);
            // Filter out the current user from results — you can't add yourself.
            const users = (data.users || []).filter(u => u.id !== state.currentUser.id);
            if (users.length === 0) {
                results.innerHTML = `<p style="color:var(--clr-text-muted);font-size:13px;text-align:center;padding:24px 0;">No users found</p>`;
                return;
            }
            results.innerHTML = '';
            users.forEach(user => {
                const isFriend = state.friends.some(f => f.id === user.id);
                const item = document.createElement('div');
                item.className = 'modal-result-item';
                item.innerHTML = `
          <div class="avatar size-md">${initials(user.username)}</div>
          <div class="contact-info">
            <div class="contact-name">${user.username}</div>
            <div class="contact-preview">${user.email || ''}</div>
          </div>
          ${isFriend
                    // Already friends — show a disabled label instead of an Add button.
                    ? `<span class="btn btn-ghost" style="font-size:11px;padding:6px 12px;cursor:default;opacity:.6;">Friends</span>`
                    : `<button class="btn btn-primary" data-action="send-friend-request" data-user-id="${user.id}" style="font-size:12px;padding:6px 14px;">Add</button>`
                }`;
                results.appendChild(item);
            });
        } catch (err) {
            results.innerHTML = `<p style="color:var(--clr-danger);font-size:13px;text-align:center;padding:24px 0;">${err.message}</p>`;
        }
    }, 300);
}

async function sendFriendRequest(receiverId, btn) {
    // Disable the button immediately to prevent duplicate requests.
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        await api.post('/friend-request', {
            requester_id: state.currentUser.id,
            receiver_id: receiverId,
        });
        btn.textContent = 'Sent ✓';
        btn.classList.replace('btn-primary', 'btn-ghost');
        toast('Friend request sent!', 'success');
    } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Add';
        toast(err.message, 'error');
    }
}


// =============================================================================
// INFO PANEL
// =============================================================================
// Toggles the slide-in contact detail panel on the right edge of the chat.
function toggleInfoPanel() {
    state.infoPanelOpen = !state.infoPanelOpen;
    document.getElementById('info-panel').classList.toggle('open', state.infoPanelOpen);
}


// =============================================================================
// BLOCK
// =============================================================================
async function handleBlock() {
    if (!state.activeFriendId) return;
    const name = document.getElementById('info-name').textContent;
    if (!confirm(`Block ${name}? This will remove them from your friends and prevent messaging.`)) return;
    try {
        await api.post('/block', {
            blocker_id: state.currentUser.id,
            blocked_id: state.activeFriendId,
        });
        toast(`${name} has been blocked.`, 'info');
        // Return to the empty-chat placeholder and close the info panel.
        state.activeFriendId = null;
        document.getElementById('active-chat').style.display = 'none';
        document.getElementById('active-chat').classList.add('hidden');
        document.getElementById('chat-empty').classList.remove('hidden');
        if (state.infoPanelOpen) toggleInfoPanel();
        await loadFriends();
    } catch (err) {
        toast(err.message, 'error');
    }
}


// =============================================================================
// SIDEBAR (MOBILE)
// =============================================================================
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('show');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebar-overlay').classList.remove('show');
}


// =============================================================================
// EVENT LISTENERS — wired here instead of inline onclick attributes
// so the Content-Security-Policy (script-src 'self') is not violated.
// =============================================================================
document.addEventListener('DOMContentLoaded', () => {

    // ── Sidebar overlay (mobile) ──────────────────────────────────────────
    document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

    // ── Add-friend modal backdrop click ──────────────────────────────────
    document.getElementById('add-friend-modal').addEventListener('click', function (e) {
        if (e.target === this) closeAddFriendModal();
    });

    // ── Auth: welcome → login / register ─────────────────────────────────
    document.getElementById('btn-show-login').addEventListener('click', () => showView('login'));
    document.getElementById('btn-show-register').addEventListener('click', () => showView('register'));

    // ── Auth: back links ─────────────────────────────────────────────────
    document.getElementById('login-back').addEventListener('click', (e) => {
        e.preventDefault(); showView('welcome');
    });
    document.getElementById('register-back').addEventListener('click', (e) => {
        e.preventDefault(); showView('welcome');
    });

    // ── Auth: cross-links between login and register ──────────────────────
    document.getElementById('login-to-register').addEventListener('click', (e) => {
        e.preventDefault(); showView('register');
    });
    document.getElementById('register-to-login').addEventListener('click', (e) => {
        e.preventDefault(); showView('login');
    });

    // ── Auth: form submissions ────────────────────────────────────────────
    document.getElementById('login-form').addEventListener('submit', handleLogin);
    document.getElementById('register-form').addEventListener('submit', handleRegister);

    // ── Nav rail ─────────────────────────────────────────────────────────
    document.getElementById('nav-add-friend-btn').addEventListener('click', openAddFriendModal);
    document.getElementById('nav-logout-btn').addEventListener('click', handleLogout);

    // ── Sidebar tabs ─────────────────────────────────────────────────────
    document.getElementById('tab-friends').addEventListener('click', () => switchTab('friends'));
    document.getElementById('tab-requests').addEventListener('click', () => switchTab('requests'));

    // ── Sidebar contact search ────────────────────────────────────────────
    document.getElementById('contact-search').addEventListener('input', (e) => {
        handleContactSearch(e.target.value);
    });

    // ── Mobile header buttons ─────────────────────────────────────────────
    document.getElementById('mobile-menu-btn').addEventListener('click', toggleSidebar);
    document.getElementById('mobile-add-btn').addEventListener('click', openAddFriendModal);

    // ── Chat empty state ──────────────────────────────────────────────────
    document.getElementById('chat-empty-add-btn').addEventListener('click', openAddFriendModal);

    // ── Chat header: info panel toggle ───────────────────────────────────
    document.getElementById('info-toggle-btn').addEventListener('click', toggleInfoPanel);

    // ── Info panel actions ────────────────────────────────────────────────
    document.getElementById('block-btn').addEventListener('click', handleBlock);
    document.getElementById('info-panel-close-btn').addEventListener('click', toggleInfoPanel);

    // ── Chat input ────────────────────────────────────────────────────────
    const chatInput = document.getElementById('chat-input');
    chatInput.addEventListener('input', (e) => autoResizeInput(e.target));
    chatInput.addEventListener('keydown', handleInputKeydown);

    // ── Send button ───────────────────────────────────────────────────────
    document.getElementById('send-btn').addEventListener('click', sendMessage);

    // ── Modal close button ────────────────────────────────────────────────
    document.getElementById('modal-close-btn').addEventListener('click', closeAddFriendModal);

    // ── Modal search input ────────────────────────────────────────────────
    document.getElementById('modal-search-input').addEventListener('input', (e) => {
        handleModalSearch(e.target.value);
    });
});

// =============================================================================
// EVENT DELEGATION — handles clicks on dynamically-created elements
// (message bubbles, request cards, modal results) without inline onclick.
// =============================================================================

// Messages container: edit / delete bubble buttons and inline edit confirm/cancel
document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action  = btn.dataset.action;
    const msgId   = btn.dataset.msgId ? Number(btn.dataset.msgId) : null;
    const userId  = btn.dataset.userId ? Number(btn.dataset.userId) : null;
    const reqId   = btn.dataset.requestId ? Number(btn.dataset.requestId) : null;

    switch (action) {
        case 'edit':
            startEdit(msgId);
            break;
        case 'delete':
            deleteMessage(msgId);
            break;
        case 'confirm-edit':
            confirmEdit(msgId);
            break;
        case 'cancel-edit':
            renderMessages();
            break;
        case 'accept':
            respondToRequest(reqId, 'accept');
            break;
        case 'decline':
            respondToRequest(reqId, 'decline');
            break;
        case 'send-friend-request':
            sendFriendRequest(userId, btn);
            break;
    }
});