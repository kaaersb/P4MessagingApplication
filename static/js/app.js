// State
const state = {
  currentUser: null,     // { id, username }
  friends: [],
  pendingRequests: [],
  activeFriendId: null,
  activeFriendshipId: null,
  messages: [],
  infoPanelOpen: false,
  currentTab: 'friends',
  pollingInterval: null,
};

// API Helpers
const api = {
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Request failed');
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Request failed');
    return data;
  },
  async delete(url, body) {
    const r = await fetch(url, {
      method: 'DELETE',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Request failed');
    return data;
  },
};

// Toast
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// Avatar
function initials(name) {
  return name ? name.slice(0, 2).toUpperCase() : '??';
}

// Date formatting
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const diff = today - d;
  if (diff < 86400000 && d.getDate() === today.getDate()) return 'Today';
  if (diff < 172800000) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtPreviewTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const diff = today - d;
  if (diff < 86400000 && d.getDate() === today.getDate())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800000)
    return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Authentication flow
function showView(view) {
  ['welcome-view', 'login-view', 'register-view'].forEach(id => {
    const el = document.getElementById(id);
    el.classList.toggle('hidden', id !== `${view}-view`);
  });
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('lg-username').value.trim();
  const password = document.getElementById('lg-password').value;
  if (!username || !password) return;

  setLoading('login', true);
  try {
    const data = await api.post('/login', { username, password });
    state.currentUser = { id: data.user_id, username: data.username };
    enterApp();
    toast(`Welcome back, ${data.username}!`, 'success');
  } catch (err) {
    showFieldError('lg-username-group', 'lg-username-error', err.message);
  } finally {
    setLoading('login', false);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('rg-username').value.trim();
  const email    = document.getElementById('rg-email').value.trim();
  const password = document.getElementById('rg-password').value;
  if (!username || !email || !password) return;

  setLoading('register', true);
  try {
    await api.post('/register', { username, email, password });
    toast('Account created! Please sign in.', 'success');
    showView('login');
    document.getElementById('lg-username').value = username;
  } catch (err) {
    showFieldError('rg-username-group', 'rg-username-error', err.message);
  } finally {
    setLoading('register', false);
  }
}

function setLoading(form, loading) {
  document.getElementById(`${form}-btn-text`).classList.toggle('hidden', loading);
  document.getElementById(`${form}-btn-spinner`).classList.toggle('hidden', !loading);
  document.getElementById(`${form}-btn`).disabled = loading;
}

function showFieldError(groupId, errorId, msg) {
  document.getElementById(groupId).classList.add('has-error');
  document.getElementById(errorId).textContent = msg;
  setTimeout(() => document.getElementById(groupId).classList.remove('has-error'), 4000);
}

function handleLogout() {
  state.currentUser = null;
  state.activeFriendId = null;
  state.messages = [];
  stopPolling();

  document.getElementById('app-screen').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
  showView('welcome');
  toast('You have been signed out.', 'info');
}

// Application Entry
function enterApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-screen').classList.remove('hidden');

  const navAvatarWrap = document.getElementById('nav-user-avatar');
  navAvatarWrap.innerHTML = `<div class="avatar size-sm online" title="${state.currentUser.username}">${initials(state.currentUser.username)}</div>`;

  loadFriends();
  loadPendingRequests();
  startPolling();
}

// Polling
function startPolling() {
  stopPolling();
  state.pollingInterval = setInterval(async () => {
    await loadFriends(true);
    await loadPendingRequests(true);
    if (state.activeFriendId) await loadMessages(true);
  }, 4000);
}
function stopPolling() {
  if (state.pollingInterval) clearInterval(state.pollingInterval);
}

// Sidebar tabs
function switchTab(tab) {
  state.currentTab = tab;
  document.getElementById('tab-friends').classList.toggle('active', tab === 'friends');
  document.getElementById('tab-requests').classList.toggle('active', tab === 'requests');
  renderContactList();
}

// Friends and friend requests
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

// Contact list
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
        <button class="req-btn accept" title="Accept" onclick="respondToRequest(${req.request_id},'accept')">✓</button>
        <button class="req-btn decline" title="Decline" onclick="respondToRequest(${req.request_id},'decline')">✕</button>
      </div>`;
    list.appendChild(item);
  });
}

// Search in the sidebar
function handleContactSearch(val) {
  renderContactList(val.trim());
}

// Start a conversation
async function openConversation(friend) {
  state.activeFriendId = friend.id;
  state.activeFriendshipId = friend.friendship_id;

  renderContactList(document.getElementById('contact-search').value);

  document.getElementById('chat-header-avatar').textContent = initials(friend.username);
  document.getElementById('chat-header-name').textContent = friend.username;

  document.getElementById('info-avatar').textContent = initials(friend.username);
  document.getElementById('info-name').textContent = friend.username;
  document.getElementById('info-email').textContent = '';

  api.get(`/users/${friend.id}`)
    .then(u => { document.getElementById('info-email').textContent = u.email || ''; })
    .catch(() => {});

  document.getElementById('chat-empty').classList.add('hidden');
  const activeChat = document.getElementById('active-chat');
  activeChat.classList.remove('hidden');
  activeChat.style.display = 'flex';

  closeSidebar();

  await loadMessages();

  document.getElementById('chat-input').focus();
}

// Messages
async function loadMessages(silent = false) {
  if (!state.activeFriendId) return;
  try {
    const data = await api.get(`/messages/${state.currentUser.id}/${state.activeFriendId}`);
    state.messages = data.messages || [];
    renderMessages();
    if (!silent) loadFriends(true);
  } catch (err) {
    if (!silent) toast('Failed to load messages', 'error');
  }
}

function renderMessages() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  const scrolledToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;

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
  state.messages.forEach((msg) => {
    const msgDate = fmtDate(msg.sent_at);
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.innerHTML = `<span class="date-divider-text">${msgDate}</span>`;
      container.appendChild(divider);
    }
    container.appendChild(createMsgElement(msg));
  });

  if (scrolledToBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function createMsgElement(msg) {
  const isSelf = msg.sender_id === state.currentUser.id;
  const row = document.createElement('div');
  row.className = `msg-row${isSelf ? ' self' : ''}`;
  row.dataset.msgId = msg.id;

  const avatarHtml = !isSelf
    ? `<div class="msg-avatar"><div class="avatar size-sm">${initials(state.friends.find(f=>f.id===msg.sender_id)?.username || '?')}</div></div>`
    : '';

  const editBtns = isSelf ? `
    <div class="bubble-actions">
      <button class="bubble-action-btn" onclick="startEdit(${msg.id})" title="Edit">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="bubble-action-btn del" onclick="deleteMessage(${msg.id})" title="Delete">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>` : '';

  const readTick = isSelf && msg.is_read ? `
    <svg class="read-ticks" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>` : '';

  row.innerHTML = `
    ${avatarHtml}
    <div class="msg-body">
      <div class="bubble" id="bubble-${msg.id}">
        ${msg.content}
        ${editBtns}
      </div>
      <div class="bubble-meta">
        <span class="bubble-time">${fmtTime(msg.sent_at)}</span>
        ${msg.is_edited ? '<span class="bubble-edited">edited</span>' : ''}
        ${readTick}
      </div>
    </div>`;

  return row;
}

// Send message
async function sendMessage() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content || !state.activeFriendId) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  try {
    await api.post('/send-message', {
      sender_id: state.currentUser.id,
      recipient_id: state.activeFriendId,
      content,
    });
    await loadMessages(true);
    const c = document.getElementById('messages-container');
    c.scrollTop = c.scrollHeight;
  } catch (err) {
    toast(err.message, 'error');
    input.value = content;
  }
}

function handleInputKeydown(e) {
  const btn = document.getElementById('send-btn');
  btn.disabled = !e.target.value.trim();
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  document.getElementById('send-btn').disabled = !el.value.trim();
}

// Edit or delete a message
function startEdit(msgId) {
  const msg = state.messages.find(m => m.id === msgId);
  if (!msg) return;
  const bubble = document.getElementById(`bubble-${msgId}`);
  bubble.innerHTML = `
    <div class="edit-inline">
      <input class="input-field" id="edit-input-${msgId}" value="${msg.content}" />
      <div class="edit-inline-actions">
        <button class="edit-confirm" onclick="confirmEdit(${msgId})" title="Save">✓</button>
        <button class="edit-cancel" onclick="renderMessages()" title="Cancel">✕</button>
      </div>
    </div>`;
  const inp = document.getElementById(`edit-input-${msgId}`);
  inp.focus();
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
    await api.put(`/messages/${msgId}`, { user_id: state.currentUser.id, new_content: newContent });
    toast('Message edited', 'success');
    await loadMessages(true);
  } catch (err) {
    toast(err.message, 'error');
    renderMessages();
  }
}

async function deleteMessage(msgId) {
  try {
    await api.delete(`/messages/${msgId}?user_id=${state.currentUser.id}`);
    toast('Message deleted', 'info');
    state.messages = state.messages.filter(m => m.id !== msgId);
    renderMessages();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Respond to friend requests
async function respondToRequest(requestId, action) {
  try {
    await api.post('/friend-request/respond', {
      request_id: requestId,
      action,
      user_id: state.currentUser.id,
    });
    toast(action === 'accept' ? 'Friend request accepted!' : 'Request declined.', action === 'accept' ? 'success' : 'info');
    await loadPendingRequests();
    await loadFriends();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Add friend
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

let modalSearchTimer;
async function handleModalSearch(val) {
  clearTimeout(modalSearchTimer);
  const results = document.getElementById('modal-search-results');
  if (!val.trim()) {
    results.innerHTML = `<p style="color:var(--clr-text-muted);font-size:13px;text-align:center;padding:24px 0;">Start typing to search for users</p>`;
    return;
  }
  results.innerHTML = `<div style="display:flex;justify-content:center;padding:20px;"><div class="spinner"></div></div>`;
  modalSearchTimer = setTimeout(async () => {
    try {
      const data = await api.get(`/users/search?query=${encodeURIComponent(val)}`);
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
            ? `<span class="btn btn-ghost" style="font-size:11px;padding:6px 12px;cursor:default;opacity:.6;">Friends</span>`
            : `<button class="btn btn-primary" onclick="sendFriendRequest(${user.id}, this)" style="font-size:12px;padding:6px 14px;">Add</button>`
          }`;
        results.appendChild(item);
      });
    } catch (err) {
      results.innerHTML = `<p style="color:var(--clr-danger);font-size:13px;text-align:center;padding:24px 0;">${err.message}</p>`;
    }
  }, 300);
}

async function sendFriendRequest(receiverId, btn) {
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

// Information panel
function toggleInfoPanel() {
  state.infoPanelOpen = !state.infoPanelOpen;
  document.getElementById('info-panel').classList.toggle('open', state.infoPanelOpen);
}

// Block a user
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

// Sidebar
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

// Event listeners
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

document.getElementById('add-friend-modal').addEventListener('click', function(e) {
  if (e.target === this) closeAddFriendModal();
});