/**
 * app.js — Main application logic for Relay.
 * Handles auth state, panel switching, friends, chats, requests, search, and blocking.
 */

// =====================
// STATE
// =====================
let currentUser = null;
let activeChatUserId = null;
let activeChatUsername = null;
let searchDebounceTimer = null;
let pollInterval = null;

// =====================
// BOOT
// =====================
document.addEventListener('DOMContentLoaded', () => {
  const stored = localStorage.getItem('relay_user');
  if (stored) {
    try { currentUser = JSON.parse(stored); } catch { currentUser = null; }
  }

  if (currentUser) {
    showView('app');
    document.getElementById('sidebar-username').textContent = currentUser.username;
    document.getElementById('user-avatar').textContent = currentUser.username[0].toUpperCase();
    loadPanel('chats');
    startPolling();
  } else {
    showView('guest');
  }
});

// =====================
// VIEWS & PANELS
// =====================
function showView(name) {
  document.getElementById('view-guest').classList.add('hidden');
  document.getElementById('view-app').classList.add('hidden');
  document.getElementById(`view-${name}`).classList.remove('hidden');
}

function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`panel-${name}`).classList.remove('hidden');
  document.querySelector(`[data-panel="${name}"]`).classList.add('active');
  loadPanel(name);
}

function loadPanel(name) {
  switch (name) {
    case 'chats':    loadFriendsForChat(); break;
    case 'friends':  loadFriends(); break;
    case 'requests': loadRequests(); break;
    case 'blocked':  loadBlocked(); break;
    case 'search':   break; // triggered by input
  }
}

// =====================
// AUTH
// =====================
function logout() {
  localStorage.removeItem('relay_user');
  clearInterval(pollInterval);
  window.location.href = '/';
}

// =====================
// POLLING (unread counts + new messages)
// =====================
function startPolling() {
  pollInterval = setInterval(async () => {
    await refreshUnreadBadge();
    if (activeChatUserId) await loadMessages(activeChatUserId, activeChatUsername, false);
  }, 5000);
}

async function refreshUnreadBadge() {
  try {
    const data = await api.get(`/messages/unread/${currentUser.id}`);
    const total = data.total_unread || 0;
    const badge = document.getElementById('total-unread-badge');
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : total;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Also update per-friend unread counts in chat list
    if (data.unread_by_sender) {
      data.unread_by_sender.forEach(({ sender_id, unread_count }) => {
        const el = document.getElementById(`unread-${sender_id}`);
        if (el) {
          el.textContent = unread_count;
          el.classList.toggle('hidden', unread_count === 0);
        }
      });
    }
  } catch {}
}

async function refreshRequestsBadge() {
  try {
    const data = await api.get(`/pending-requests/${currentUser.id}`);
    const count = data.requests.length;
    const badge = document.getElementById('requests-badge');
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } catch {}
}

// =====================
// CHATS PANEL
// =====================
async function loadFriendsForChat() {
  try {
    const data = await api.get(`/friends/${currentUser.id}`);
    const list = document.getElementById('chat-list');
    if (!data.friends.length) {
      list.innerHTML = '<p class="empty-state">No conversations yet.<br/>Add some friends to get started.</p>';
      return;
    }
    list.innerHTML = data.friends.map(f => `
      <div class="chat-list-item ${activeChatUserId === f.id ? 'active' : ''}"
           id="chat-item-${f.id}"
           onclick="openChat(${f.id}, '${escHtml(f.username)}')">
        <div class="chat-list-avatar">${f.username[0].toUpperCase()}</div>
        <div class="chat-list-info">
          <div class="chat-list-name">${escHtml(f.username)}</div>
          <div class="chat-list-preview">${f.last_message ? escHtml(f.last_message).substring(0, 40) : '<span class="muted">No messages yet</span>'}</div>
        </div>
        <div class="chat-list-meta">
          ${f.last_message_time ? `<div class="chat-list-time">${formatTime(f.last_message_time)}</div>` : ''}
          <span class="unread-badge ${f.unread_count ? '' : 'hidden'}" id="unread-${f.id}">${f.unread_count || 0}</span>
        </div>
      </div>
    `).join('');
  } catch (e) {
    showToast('Failed to load chats: ' + e.message);
  }
}

async function openChat(userId, username) {
  activeChatUserId = userId;
  activeChatUsername = username;

  // Update sidebar active state
  document.querySelectorAll('.chat-list-item').forEach(el => el.classList.remove('active'));
  const item = document.getElementById(`chat-item-${userId}`);
  if (item) item.classList.add('active');

  document.getElementById('chat-empty-state').classList.add('hidden');
  document.getElementById('chat-active').classList.remove('hidden');
  document.getElementById('chat-with-name').textContent = username;

  await loadMessages(userId, username, true);
}

async function loadMessages(userId, username, scrollToBottom) {
  try {
    const data = await api.get(`/messages/${currentUser.id}/${userId}`);
    const area = document.getElementById('messages-area');

    const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;

    area.innerHTML = data.messages.map(m => {
      const isMine = m.sender_id === currentUser.id;
      return `
        <div class="msg-row ${isMine ? 'msg-mine' : 'msg-theirs'}" data-id="${m.id}">
          <div class="msg-bubble">
            <span class="msg-content" id="msg-content-${m.id}">${escHtml(m.content)}</span>
            ${m.is_edited ? '<span class="msg-edited">(edited)</span>' : ''}
          </div>
          <div class="msg-meta">
            <span class="msg-time">${formatTime(m.sent_at)}</span>
            ${isMine ? `
              <button class="msg-action" onclick="startEdit(${m.id}, \`${escAttr(m.content)}\`)">Edit</button>
              <button class="msg-action msg-action-del" onclick="deleteMessage(${m.id})">Delete</button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('') || '<p class="empty-state">No messages yet. Say hello!</p>';

    if (scrollToBottom || wasAtBottom) {
      area.scrollTop = area.scrollHeight;
    }

    // Clear unread badge for this user
    const badge = document.getElementById(`unread-${userId}`);
    if (badge) badge.classList.add('hidden');
    refreshUnreadBadge();
  } catch (e) {
    showToast('Failed to load messages: ' + e.message);
  }
}

async function sendMessage() {
  if (!activeChatUserId) return;
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content) return;

  input.value = '';
  try {
    await api.post('/send-message', {
      sender_id: currentUser.id,
      recipient_id: activeChatUserId,
      content
    });
    await loadMessages(activeChatUserId, activeChatUsername, true);
    await loadFriendsForChat(); // refresh preview
  } catch (e) {
    showToast('Failed to send: ' + e.message);
    input.value = content;
  }
}

function startEdit(messageId, currentContent) {
  const contentEl = document.getElementById(`msg-content-${messageId}`);
  const row = contentEl.closest('.msg-row');

  row.querySelector('.msg-meta').classList.add('hidden');
  contentEl.innerHTML = `
    <input class="msg-edit-input" id="edit-input-${messageId}" value="${escAttr(currentContent)}" />
    <button class="btn-send" onclick="submitEdit(${messageId})">Save</button>
    <button class="msg-action" onclick="cancelEdit(${messageId}, \`${escAttr(currentContent)}\`)">Cancel</button>
  `;
  document.getElementById(`edit-input-${messageId}`).focus();
}

async function submitEdit(messageId) {
  const input = document.getElementById(`edit-input-${messageId}`);
  const newContent = input.value.trim();
  if (!newContent) return;

  try {
    await api.put(`/messages/${messageId}`, { user_id: currentUser.id, new_content: newContent });
    await loadMessages(activeChatUserId, activeChatUsername, false);
  } catch (e) {
    showToast('Edit failed: ' + e.message);
  }
}

function cancelEdit(messageId, originalContent) {
  const contentEl = document.getElementById(`msg-content-${messageId}`);
  contentEl.textContent = originalContent;
  const row = contentEl.closest('.msg-row');
  row.querySelector('.msg-meta').classList.remove('hidden');
}

async function deleteMessage(messageId) {
  if (!confirm('Delete this message?')) return;
  try {
    await api.delete(`/messages/${messageId}`, { user_id: currentUser.id });
    await loadMessages(activeChatUserId, activeChatUsername, false);
    await loadFriendsForChat();
  } catch (e) {
    showToast('Delete failed: ' + e.message);
  }
}

// =====================
// FRIENDS PANEL
// =====================
async function loadFriends() {
  const list = document.getElementById('friends-list');
  list.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const data = await api.get(`/friends/${currentUser.id}`);
    if (!data.friends.length) {
      list.innerHTML = '<p class="empty-state">No friends yet. Use "Find People" to add some!</p>';
      return;
    }
    list.innerHTML = data.friends.map(f => `
      <div class="user-card">
        <div class="user-card-avatar">${f.username[0].toUpperCase()}</div>
        <div class="user-card-info">
          <span class="user-card-name">${escHtml(f.username)}</span>
        </div>
        <div class="user-card-actions">
          <button class="btn btn-sm btn-primary" onclick="showPanel('chats'); openChat(${f.id}, '${escHtml(f.username)}')">Message</button>
          <button class="btn btn-sm btn-danger" onclick="removeFriend(${f.friendship_id})">Unfriend</button>
          <button class="btn btn-sm btn-ghost" onclick="blockUser(${f.id}, '${escHtml(f.username)}')">Block</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Error: ${escHtml(e.message)}</p>`;
  }
}

async function removeFriend(friendshipId) {
  if (!confirm('Remove this friend?')) return;
  try {
    await api.delete(`/friends/${friendshipId}`, { user_id: currentUser.id });
    showToast('Friend removed.');
    loadFriends();
    loadFriendsForChat();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

// =====================
// REQUESTS PANEL
// =====================
async function loadRequests() {
  const list = document.getElementById('requests-list');
  list.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const data = await api.get(`/pending-requests/${currentUser.id}`);
    const badge = document.getElementById('requests-badge');
    if (!data.requests.length) {
      list.innerHTML = '<p class="empty-state">No pending friend requests.</p>';
      badge.classList.add('hidden');
      return;
    }
    badge.textContent = data.requests.length;
    badge.classList.remove('hidden');

    list.innerHTML = data.requests.map(r => `
      <div class="user-card">
        <div class="user-card-avatar">${r.username[0].toUpperCase()}</div>
        <div class="user-card-info">
          <span class="user-card-name">${escHtml(r.username)}</span>
          <span class="user-card-sub">wants to be your friend</span>
        </div>
        <div class="user-card-actions">
          <button class="btn btn-sm btn-primary" onclick="respondRequest(${r.request_id}, 'accept')">Accept</button>
          <button class="btn btn-sm btn-ghost" onclick="respondRequest(${r.request_id}, 'decline')">Decline</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Error: ${escHtml(e.message)}</p>`;
  }
}

async function respondRequest(requestId, action) {
  try {
    await api.post('/friend-request/respond', { request_id: requestId, action });
    showToast(action === 'accept' ? 'Friend request accepted!' : 'Request declined.');
    loadRequests();
    if (action === 'accept') loadFriendsForChat();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

// =====================
// SEARCH PANEL
// =====================
function debounceSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, 350);
}

async function runSearch() {
  const query = document.getElementById('search-input').value.trim();
  const results = document.getElementById('search-results');
  if (!query) { results.innerHTML = ''; return; }

  results.innerHTML = '<p class="empty-state">Searching...</p>';
  try {
    const data = await api.get('/users/search', { query });
    const users = data.users.filter(u => u.id !== currentUser.id);
    if (!users.length) {
      results.innerHTML = '<p class="empty-state">No users found.</p>';
      return;
    }
    results.innerHTML = users.map(u => `
      <div class="user-card">
        <div class="user-card-avatar">${u.username[0].toUpperCase()}</div>
        <div class="user-card-info">
          <span class="user-card-name">${escHtml(u.username)}</span>
          <span class="user-card-sub">${escHtml(u.email)}</span>
        </div>
        <div class="user-card-actions">
          <button class="btn btn-sm btn-primary" onclick="sendFriendRequest(${u.id}, this)">Add Friend</button>
          <button class="btn btn-sm btn-ghost" onclick="blockUser(${u.id}, '${escHtml(u.username)}')">Block</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    results.innerHTML = `<p class="empty-state">Error: ${escHtml(e.message)}</p>`;
  }
}

async function sendFriendRequest(receiverId, btn) {
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    await api.post('/friend-request', { requester_id: currentUser.id, receiver_id: receiverId });
    btn.textContent = 'Sent ✓';
    showToast('Friend request sent!');
    refreshRequestsBadge();
  } catch (e) {
    showToast('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Add Friend';
  }
}

// =====================
// BLOCKED PANEL
// =====================
async function loadBlocked() {
  const list = document.getElementById('blocked-list');
  list.innerHTML = '<p class="empty-state">Loading...</p>';
  try {
    const data = await api.get(`/blocked/${currentUser.id}`);
    if (!data.blocked_users.length) {
      list.innerHTML = '<p class="empty-state">No blocked users.</p>';
      return;
    }
    list.innerHTML = data.blocked_users.map(u => `
      <div class="user-card">
        <div class="user-card-avatar">${u.username[0].toUpperCase()}</div>
        <div class="user-card-info">
          <span class="user-card-name">${escHtml(u.username)}</span>
          <span class="user-card-sub muted">Blocked</span>
        </div>
        <div class="user-card-actions">
          <button class="btn btn-sm btn-ghost" onclick="unblockUser(${u.id}, '${escHtml(u.username)}')">Unblock</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<p class="empty-state">Error: ${escHtml(e.message)}</p>`;
  }
}

async function blockUser(userId, username) {
  if (!confirm(`Block ${username}? This will also remove them as a friend.`)) return;
  try {
    await api.post('/block', { blocker_id: currentUser.id, blocked_id: userId });
    showToast(`${username} blocked.`);
    loadFriends();
    loadFriendsForChat();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

async function unblockUser(userId, username) {
  try {
    await api.delete('/block', { blocker_id: currentUser.id, blocked_id: userId });
    showToast(`${username} unblocked.`);
    loadBlocked();
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

// =====================
// UTILITIES
// =====================
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  if (!str) return '';
  return String(str).replace(/`/g, '\\`').replace(/\\/g, '\\\\');
}

function formatTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

let toastTimer;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}