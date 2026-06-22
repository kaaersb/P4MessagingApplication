from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime, timezone
import psycopg2
import json
import os
import secrets
import time
import html
import bcrypt
from dotenv import load_dotenv
from collections import defaultdict
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

load_dotenv()

app = FastAPI()


# ============================================================
# ===== SECURITY MIDDLEWARE ==================================
# ============================================================

# AT3 & AT4 — Credential Sniffing & Message Interception
# Force HTTPS so all traffic (including login credentials and messages)
# is encrypted in transit.

app.add_middleware(HTTPSRedirectMiddleware)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "p4app.duckdns.org"])


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """
    AT3 & AT4 — Add HTTP security headers on every response.
    HSTS tells browsers to always use HTTPS even if the user types http://.
    The other headers reduce XSS surface and clickjacking risk.
    """
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # Enforce HTTPS for one year
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        # Prevent browsers from inferring a different MIME type
        response.headers["X-Content-Type-Options"] = "nosniff"
        # Disallow embedding in iframes
        response.headers["X-Frame-Options"] = "DENY"
        # CSP: restrict inline scripts and external sources
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com; "
            "connect-src 'self' ws: wss:; "
            "img-src 'self' data:;"
        )
        return response

app.add_middleware(SecurityHeadersMiddleware)


# Simple in-process token-bucket rate limiter.
# For multi-process deployments, replace the in-memory dict with Redis.

class RateLimiter:
    def __init__(self):
        # {ip: [timestamp, ...]}
        self._requests: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, ip: str, max_requests: int = 60, window_seconds: int = 60) -> bool:
        now = time.time()
        window_start = now - window_seconds
        hits = self._requests[ip]
        # Purge old entries
        self._requests[ip] = [t for t in hits if t > window_start]
        if len(self._requests[ip]) >= max_requests:
            return False
        self._requests[ip].append(now)
        return True

rate_limiter = RateLimiter()


def check_rate_limit(request: Request, max_requests: int, window_seconds: int):
    """
    Per-endpoint rate limiter. Uses a compound key of IP + limit params so
    each endpoint has its own independent bucket.
    Call this at the top of any endpoint that needs protecting.
    Polling/read endpoints are intentionally left unrestricted — they are
    authenticated and cheap, so a global cap would only hurt active users.
    """
    client_ip = request.client.host if request.client else "unknown"
    key = f"{client_ip}:{max_requests}:{window_seconds}"
    if not rate_limiter.is_allowed(key, max_requests, window_seconds):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please slow down.",
        )


# ============================================================
# ===== STATIC FILES =========================================
# ============================================================

app.mount("/styles", StaticFiles(directory="static/styles"), name="styles")
app.mount("/js",     StaticFiles(directory="static/js"),     name="js")


# ============================================================
# ===== DB CONNECTION ========================================
# ============================================================

def get_db():
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    try:
        yield conn
    finally:
        conn.close()


# ============================================================
# ===== SESSION STORE ========================================
# ============================================================
# Sessions are stored server-side.  The client only holds a random
# 256-bit token (HttpOnly cookie), so there is nothing predictable
# to guess and nothing sensitive stored client-side.

sessions: dict[str, dict] = {}   # token -> {"user_id": int, "username": str, "created_at": float}
SESSION_TTL = 3600 * 8           # 8 hours


def create_session(user_id: int, username: str) -> str:
    token = secrets.token_hex(32)   # 256 bits of randomness
    sessions[token] = {
        "user_id": user_id,
        "username": username,
        "created_at": time.time(),
    }
    return token


def get_session(request: Request) -> Optional[dict]:
    token = request.cookies.get("session_token")
    if not token:
        return None
    session = sessions.get(token)
    if not session:
        return None
    # Enforce TTL
    if time.time() - session["created_at"] > SESSION_TTL:
        sessions.pop(token, None)
        return None
    return session


def require_session(request: Request) -> dict:
    """
    FastAPI dependency — raises 401 if the request has no valid session.
    Attach as `session: dict = Depends(require_session)` on protected routes.
    """
    session = get_session(request)
    if not session:
        raise HTTPException(status_code=401, detail="Authentication required")
    return session


# ============================================================
# ===== DATA MODELS ==========================================
# ============================================================

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str

    @field_validator("username")
    @classmethod
    def username_length(cls, v: str) -> str:
        if len(v.strip()) < 3 or len(v) > 50:
            raise ValueError("Username must be 3–50 characters")
        return v.strip()

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class LoginRequest(BaseModel):
    username: str
    password: str


class MessageRequest(BaseModel):
    # Impersonation: sender_id is ignored from the request body;
    # the real sender is taken from the authenticated session.
    recipient_id: int
    content: str

    @field_validator("content")
    @classmethod
    def content_not_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("Message content cannot be empty")
        if len(stripped) > 10_000:
            raise ValueError("Message is too long (max 10 000 chars)")
        return stripped


class EditMessageRequest(BaseModel):
    new_content: str

    @field_validator("new_content")
    @classmethod
    def content_not_empty(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("Content cannot be empty")
        if len(stripped) > 10_000:
            raise ValueError("Message is too long (max 10 000 chars)")
        return stripped


class FriendRequest(BaseModel):
    receiver_id: int


class FriendRequestResponse(BaseModel):
    request_id: int
    action: str   # "accept" or "decline"


class BlockRequest(BaseModel):
    blocked_id: int


# ============================================================
# ===== HELPERS ==============================================
# ============================================================

# ============================================================
# ===== HELPERS ==============================================
# ============================================================

def sanitize_output(text: str) -> str:
    """
    XSS: HTML-escape any user-supplied text before it is embedded
    in JSON that the frontend renders into the DOM. This is a belt-and-
    suspenders measure; the frontend should also use textContent rather
    than innerHTML when displaying message bodies.
    """
    if text is None:
        return text
    return html.escape(str(text))


def hash_password(plain: str) -> str:
    """Password Cracking: store bcrypt hashes, never plaintext."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


# Valid bcrypt hash used when a username does not exist.
# This allows login to still perform a bcrypt check, reducing username
# enumeration through timing differences, without causing HTTP 500 errors.
DUMMY_PASSWORD_HASH = hash_password("dummy_password_for_timing_protection")


def verify_password(plain: str, hashed: str) -> bool:
    """
    Verify a plaintext password against a bcrypt hash.

    The try/except ensures malformed or legacy password values do not crash
    the login endpoint. Instead, invalid hashes are treated as failed logins.
    """
    try:
        return bcrypt.checkpw(plain.encode(), hashed.encode())
    except (ValueError, TypeError):
        return False





# ============================================================
# ===== WEBSOCKET CONNECTION MGR =============================
# ============================================================

class ConnectionManager:
    def __init__(self):
        self.active: dict[int, list[WebSocket]] = {}

    async def connect(self, user_id: int, ws: WebSocket):
        await ws.accept()
        self.active.setdefault(user_id, []).append(ws)

    def disconnect(self, user_id: int, ws: WebSocket):
        connections = self.active.get(user_id, [])
        if ws in connections:
            connections.remove(ws)
        if not connections:
            self.active.pop(user_id, None)

    async def send_to_user(self, user_id: int, payload: dict):
        dead = []
        for ws in self.active.get(user_id, []):
            try:
                await ws.send_text(json.dumps(payload))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(user_id, ws)

    async def broadcast(self, user_ids: list[int], payload: dict):
        for uid in user_ids:
            await self.send_to_user(uid, payload)


manager = ConnectionManager()


# Session Hijacking via WebSocket:
# The WS endpoint now validates the session cookie rather than
# accepting an arbitrary user_id from the URL path.
@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: int):
    # Validate session from cookie before accepting the socket
    token = websocket.cookies.get("session_token")
    if not token or token not in sessions:
        await websocket.close(code=4401)
        return
    session = sessions[token]
    if session["user_id"] != user_id:
        await websocket.close(code=4403)
        return

    await manager.connect(user_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(user_id, websocket)


# ============================================================
# ===== AUTH ENDPOINTS =======================================
# ============================================================

@app.post("/register")
def register(data: RegisterRequest, request: Request):
    """
    Register a new user.
    SQLi: parameterised query (no string interpolation).
    Password Cracking: password stored as bcrypt hash.
    Resource Exhaustion: auth rate limit applied.
    """
    # 5 registration attempts per minute per IP — spam account protection
    check_rate_limit(request, max_requests=5, window_seconds=60)

    conn = get_db()
    cursor = conn.cursor()
    try:
        #hash the password before storing it
        hashed = hash_password(data.password)

        # parameterised query — never interpolate user input into SQL
        cursor.execute(
            "INSERT INTO users (username, email, password) VALUES (%s, %s, %s) RETURNING id",
            (data.username, data.email, hashed)
        )
        user_id = cursor.fetchone()[0]
        conn.commit()
        return {"message": "User registered successfully", "user_id": user_id}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.post("/login")
def login(data: LoginRequest, request: Request):
    """
    Authenticate a user and issue a session cookie.

    Login Bypass (SQLi): parameterised query + bcrypt verification.
    Credential Sniffing: HTTPS middleware encrypts the channel.
    Session Hijacking: issues a cryptographically random token.
    Password Cracking: compares against bcrypt hash, not plaintext.
    Resource Exhaustion: strict auth rate limit.
    """
    # 10 login attempts per minute per IP — brute force / credential stuffing protection
    check_rate_limit(request, max_requests=10, window_seconds=60)

    conn = get_db()
    cursor = conn.cursor()

    try:
        # Parameterised query: user input never touches the SQL string.
        cursor.execute(
            "SELECT id, username, password FROM users WHERE username = %s",
            (data.username,)
        )
        user = cursor.fetchone()

        # Always perform a bcrypt comparison, even if the username does not exist.
        # This helps reduce timing differences between existing and non-existing users.
        stored_hash = user[2] if user else DUMMY_PASSWORD_HASH
        password_ok = verify_password(data.password, stored_hash)

        if not user or not password_ok:
            raise HTTPException(
                status_code=401,
                detail="Invalid username or password"
            )

        # Create a server-side session with a random 256-bit token.
        token = create_session(user[0], user[1])

        response = {
            "message": "Login successful",
            "user_id": user[0],
            "username": user[1],
        }

        from fastapi.responses import JSONResponse
        resp = JSONResponse(content=response)

        # HttpOnly prevents JavaScript from reading the cookie.
        # Secure ensures it is only sent over HTTPS.
        # SameSite=Strict reduces CSRF risk.
        resp.set_cookie(
            key="session_token",
            value=token,
            httponly=True,
            secure=True,
            samesite="strict",
            max_age=SESSION_TTL,
        )

        return resp

    except HTTPException:
        raise

    except Exception:
        # Do not expose internal database or bcrypt errors to the client.
        raise HTTPException(
            status_code=500,
            detail="Internal authentication error"
        )

    finally:
        cursor.close()
        conn.close()


@app.post("/logout")
def logout(request: Request, session: dict = Depends(require_session)):
    """Invalidate the session server-side and clear the cookie."""
    token = request.cookies.get("session_token")
    if token:
        sessions.pop(token, None)

    from fastapi.responses import JSONResponse
    resp = JSONResponse(content={"message": "Logged out"})
    resp.delete_cookie("session_token")
    return resp


# ============================================================
# ===== USER ENDPOINTS =======================================
# ============================================================

@app.get("/users")
def get_users(session: dict = Depends(require_session)):
    """Get all registered users. Requires authentication."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, username, email FROM users")
        rows = cursor.fetchall()
        return {"users": [{"id": r[0], "username": r[1], "email": r[2]} for r in rows]}
    finally:
        cursor.close()
        conn.close()


@app.get("/users/search")
def search_users(query: str, request: Request, session: dict = Depends(require_session)):
    """
    Search for users by username (partial match).
    Database Dumping (SQLi): parameterised ILIKE with %s placeholder;
          user input is never interpolated into the SQL string.
    Resource Exhaustion: moderate rate limit to prevent scraping.
    """
    # 30 searches per minute per IP — scraping / enumeration protection
    check_rate_limit(request, max_requests=30, window_seconds=60)
    conn = get_db()
    cursor = conn.cursor()
    try:
        # parameterised query
        cursor.execute(
            "SELECT id, username, email FROM users WHERE username ILIKE %s",
            (f"%{query}%",)
        )
        rows = cursor.fetchall()
        return {"users": [{"id": r[0], "username": r[1], "email": r[2]} for r in rows]}
    finally:
        cursor.close()
        conn.close()


@app.get("/users/{user_id}")
def get_user(user_id: int, session: dict = Depends(require_session)):
    """Get a specific user's profile by ID. Requires authentication."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, username, email FROM users WHERE id = %s", (user_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        return {"id": row[0], "username": row[1], "email": row[2]}
    finally:
        cursor.close()
        conn.close()


# ============================================================
# ===== MESSAGE ENDPOINTS ====================================
# ============================================================


@app.post("/send-message")
async def send_message(data: MessageRequest, request: Request, session: dict = Depends(require_session)):
    """
    Send a direct message.
    IDOR: sender_id comes from the validated session, not the request body.
    XSS: message content is HTML-escaped before being stored/broadcast.
    Impersonation: sender identity is taken from the server-side session.
    Resource Exhaustion: per-IP rate limit (60 msg / 60 s).
    """
    # 60 messages per minute — generous for active users, still caps spam/DoS
    check_rate_limit(request, max_requests=60, window_seconds=60)

    # ignore any sender_id the client might have sent; use the session
    sender_id = session["user_id"]

    # escape HTML entities so script tags in messages cannot execute
    safe_content = sanitize_output(data.content)

    conn = get_db()
    cursor = conn.cursor()
    try:
        # Check the sender has not been blocked by the recipient
        cursor.execute(
            "SELECT id FROM blocks WHERE blocker_id = %s AND blocked_id = %s",
            (data.recipient_id, sender_id)
        )
        if cursor.fetchone():
            raise HTTPException(status_code=403, detail="You cannot message this user")

        cursor.execute(
            """INSERT INTO messages (sender_id, recipient_id, content, is_read)
               VALUES (%s, %s, %s, FALSE) RETURNING id, sent_at""",
            (sender_id, data.recipient_id, safe_content)
        )
        row = cursor.fetchone()
        message_id = row[0]
        sent_at    = row[1]
        conn.commit()

        payload = {
            "type": "new_message",
            "message": {
                "id":           message_id,
                "sender_id":    sender_id,
                "recipient_id": data.recipient_id,
                "content":      safe_content,
                "sent_at":      sent_at.isoformat() if sent_at else datetime.now(timezone.utc).isoformat(),
                "is_read":      False,
                "is_edited":    False,
            },
        }
        await manager.broadcast([sender_id, data.recipient_id], payload)
        return {"message": "Message sent successfully", "message_id": message_id}

    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.get("/messages/unread/{user_id}")
def get_unread_count(user_id: int, session: dict = Depends(require_session)):
    """
    Get unread message counts per sender.
    IDOR: verifies the requested user_id matches the session owner.
    """
    if session["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT sender_id, COUNT(*) as unread_count
               FROM messages
               WHERE recipient_id = %s AND is_read = FALSE
               GROUP BY sender_id""",
            (user_id,)
        )
        rows = cursor.fetchall()
        unread = [{"sender_id": r[0], "unread_count": r[1]} for r in rows]
        return {"unread_by_sender": unread, "total_unread": sum(r["unread_count"] for r in unread)}
    finally:
        cursor.close()
        conn.close()


@app.get("/messages/{user_id}/{other_user_id}")
async def get_messages(user_id: int, other_user_id: int, session: dict = Depends(require_session)):
    """
    Get the conversation between two users.
    IDOR: only allows the authenticated user to fetch their own messages.
    """
    #ensure the caller can only fetch conversations they are part of
    if session["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT id FROM messages
               WHERE sender_id = %s AND recipient_id = %s AND is_read = FALSE""",
            (other_user_id, user_id)
        )
        newly_read_ids = [r[0] for r in cursor.fetchall()]

        cursor.execute(
            """UPDATE messages SET is_read = TRUE
               WHERE sender_id = %s AND recipient_id = %s AND is_read = FALSE""",
            (other_user_id, user_id)
        )

        cursor.execute(
            """SELECT id, sender_id, recipient_id, content, sent_at, is_read, is_edited
               FROM messages
               WHERE (sender_id = %s AND recipient_id = %s)
                  OR (sender_id = %s AND recipient_id = %s)
               ORDER BY sent_at ASC""",
            (user_id, other_user_id, other_user_id, user_id)
        )
        rows = cursor.fetchall()
        conn.commit()

        messages = [
            {
                "id":           r[0],
                "sender_id":    r[1],
                "recipient_id": r[2],
                "content":      r[3],   # already sanitised at insert time
                "sent_at":      r[4].isoformat() if r[4] else None,
                "is_read":      r[5],
                "is_edited":    r[6],
            }
            for r in rows
        ]

        import asyncio
        for mid in newly_read_ids:
            asyncio.create_task(
                manager.send_to_user(other_user_id, {"type": "message_read", "message_id": mid})
            )
        return {"messages": messages}

    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.put("/messages/{message_id}")
async def edit_message(message_id: int, data: EditMessageRequest, session: dict = Depends(require_session)):
    """
    Edit a message. Only the original sender (verified via session) may edit.
    user_id comes from session, not from the request body.
    new content is HTML-escaped.
    """
    user_id = session["user_id"]
    safe_content = sanitize_output(data.new_content)

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT sender_id, recipient_id FROM messages WHERE id = %s",
            (message_id,)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        # session user must be the original sender
        if row[0] != user_id:
            raise HTTPException(status_code=403, detail="You can only edit your own messages")

        sender_id    = row[0]
        recipient_id = row[1]

        cursor.execute(
            "UPDATE messages SET content = %s, is_edited = TRUE WHERE id = %s",
            (safe_content, message_id)
        )
        conn.commit()

        payload = {"type": "message_edited", "message_id": message_id, "new_content": safe_content}
        await manager.broadcast([sender_id, recipient_id], payload)
        return {"message": "Message edited successfully"}

    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.delete("/messages/{message_id}")
async def delete_message(message_id: int, request: Request, session: dict = Depends(require_session)):
    """
    Delete a message. Only the original sender may delete.
    identity comes from session, ignoring any query-string user_id.
    """
    user_id = session["user_id"]

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT sender_id, recipient_id FROM messages WHERE id = %s",
            (message_id,)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        if row[0] != user_id:
            raise HTTPException(status_code=403, detail="You can only delete your own messages")

        sender_id    = row[0]
        recipient_id = row[1]

        cursor.execute("DELETE FROM messages WHERE id = %s", (message_id,))
        conn.commit()

        payload = {"type": "message_deleted", "message_id": message_id}
        await manager.broadcast([sender_id, recipient_id], payload)
        return {"message": "Message deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


# ============================================================
# ===== FRIENDSHIP ENDPOINTS =================================
# ============================================================

@app.post("/friend-request")
async def send_friend_request(data: FriendRequest, session: dict = Depends(require_session)):
    """
    Send a friend request.
    requester_id is taken from session, not the request body.
    """
    requester_id = session["user_id"]

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT id FROM friendships
               WHERE (requester_id = %s AND receiver_id = %s)
                  OR (requester_id = %s AND receiver_id = %s)""",
            (requester_id, data.receiver_id, data.receiver_id, requester_id)
        )
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="Friend request already exists")

        cursor.execute(
            "INSERT INTO friendships (requester_id, receiver_id, status) VALUES (%s, %s, 'pending') RETURNING id",
            (requester_id, data.receiver_id)
        )
        request_id = cursor.fetchone()[0]
        conn.commit()

        await manager.send_to_user(data.receiver_id, {"type": "friend_request"})
        return {"message": "Friend request sent", "request_id": request_id}

    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.post("/friend-request/respond")
async def respond_to_friend_request(data: FriendRequestResponse, session: dict = Depends(require_session)):
    """
    Accept or decline a friend request.
    responder identity comes from session, not request body.
    """
    user_id = session["user_id"]

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT id, requester_id FROM friendships WHERE id = %s AND receiver_id = %s",
            (data.request_id, user_id)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=403, detail="You can only respond to your own friend requests")

        requester_id = row[1]

        if data.action == "accept":
            cursor.execute(
                "UPDATE friendships SET status = 'accepted' WHERE id = %s",
                (data.request_id,)
            )
            conn.commit()
            await manager.broadcast([user_id, requester_id], {"type": "friend_accepted"})
        elif data.action == "decline":
            cursor.execute("DELETE FROM friendships WHERE id = %s", (data.request_id,))
            conn.commit()
        else:
            raise HTTPException(status_code=400, detail="Action must be 'accept' or 'decline'")

        return {"message": f"Friend request {data.action}ed"}

    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.delete("/friends/{friendship_id}")
def remove_friend(friendship_id: int, session: dict = Depends(require_session)):
    """
    Remove a friend.
    user_id comes from session only.
    """
    user_id = session["user_id"]

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT id FROM friendships
               WHERE id = %s AND (requester_id = %s OR receiver_id = %s) AND status = 'accepted'""",
            (friendship_id, user_id, user_id)
        )
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Friendship not found")
        cursor.execute("DELETE FROM friendships WHERE id = %s", (friendship_id,))
        conn.commit()
        return {"message": "Friend removed successfully"}
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.get("/friends/{user_id}")
def get_friends(user_id: int, session: dict = Depends(require_session)):
    """
    Get friends list with last-message preview.
    only the authenticated user may fetch their own friends list.
    """
    if session["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT
                u.id, u.username,
                f.id as friendship_id,
                (
                    SELECT content FROM messages
                    WHERE (sender_id = u.id AND recipient_id = %s)
                       OR (sender_id = %s AND recipient_id = u.id)
                    ORDER BY sent_at DESC LIMIT 1
                ) as last_message,
                (
                    SELECT sent_at FROM messages
                    WHERE (sender_id = u.id AND recipient_id = %s)
                       OR (sender_id = %s AND recipient_id = u.id)
                    ORDER BY sent_at DESC LIMIT 1
                ) as last_message_time,
                (
                    SELECT COUNT(*) FROM messages
                    WHERE sender_id = u.id AND recipient_id = %s AND is_read = FALSE
                ) as unread_count
            FROM friendships f
            JOIN users u ON (
                CASE WHEN f.requester_id = %s THEN f.receiver_id ELSE f.requester_id END = u.id
            )
            WHERE (f.requester_id = %s OR f.receiver_id = %s)
              AND f.status = 'accepted'
            ORDER BY last_message_time DESC NULLS LAST
            """,
            (user_id, user_id, user_id, user_id, user_id, user_id, user_id, user_id)
        )
        rows = cursor.fetchall()
        friends = [
            {
                "id":                row[0],
                "username":          row[1],
                "friendship_id":     row[2],
                "last_message":      row[3],
                "last_message_time": row[4].isoformat() if row[4] else None,
                "unread_count":      row[5],
            }
            for row in rows
        ]
        return {"friends": friends}
    finally:
        cursor.close()
        conn.close()


@app.get("/pending-requests/{user_id}")
def get_pending_requests(user_id: int, session: dict = Depends(require_session)):
    """
    Get incoming pending friend requests.
    only the authenticated user may fetch their own requests.
    """
    if session["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT f.id, u.id as requester_id, u.username
            FROM friendships f
            JOIN users u ON f.requester_id = u.id
            WHERE f.receiver_id = %s AND f.status = 'pending'
            """,
            (user_id,)
        )
        rows = cursor.fetchall()
        return {
            "requests": [
                {"request_id": r[0], "requester_id": r[1], "username": r[2]}
                for r in rows
            ]
        }
    finally:
        cursor.close()
        conn.close()


# ============================================================
# ===== BLOCK ENDPOINTS ======================================
# ============================================================

@app.post("/block")
def block_user(data: BlockRequest, session: dict = Depends(require_session)):
    """
    Block a user.
    blocker_id comes from session, not request body.
    """
    blocker_id = session["user_id"]

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """DELETE FROM friendships
               WHERE (requester_id = %s AND receiver_id = %s)
                  OR (requester_id = %s AND receiver_id = %s)""",
            (blocker_id, data.blocked_id, data.blocked_id, blocker_id)
        )
        cursor.execute(
            "SELECT id FROM blocks WHERE blocker_id = %s AND blocked_id = %s",
            (blocker_id, data.blocked_id)
        )
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="User is already blocked")
        cursor.execute(
            "INSERT INTO blocks (blocker_id, blocked_id) VALUES (%s, %s)",
            (blocker_id, data.blocked_id)
        )
        conn.commit()
        return {"message": "User blocked successfully"}
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.delete("/block")
def unblock_user(blocked_id: int, session: dict = Depends(require_session)):
    """
    Unblock a user.
    blocker_id comes from session.
    """
    blocker_id = session["user_id"]

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "DELETE FROM blocks WHERE blocker_id = %s AND blocked_id = %s",
            (blocker_id, blocked_id)
        )
        conn.commit()
        return {"message": "User unblocked successfully"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.get("/blocked/{user_id}")
def get_blocked_users(user_id: int, session: dict = Depends(require_session)):
    """
    Get blocked users list.
    only the authenticated user may view their own block list.
    """
    if session["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT u.id, u.username FROM blocks b
               JOIN users u ON b.blocked_id = u.id
               WHERE b.blocker_id = %s""",
            (user_id,)
        )
        rows = cursor.fetchall()
        return {"blocked_users": [{"id": r[0], "username": r[1]} for r in rows]}
    finally:
        cursor.close()
        conn.close()


# ============================================================
# ===== FRONTEND ENTRY =======================================
# ============================================================

@app.get("/")
def serve_frontend():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
