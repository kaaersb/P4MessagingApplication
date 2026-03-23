from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# ========================
# ===== STATIC FILES =====
# ========================

app.mount("/styles", StaticFiles(directory="static/styles"), name="styles")
app.mount("/js", StaticFiles(directory="static/js"), name="js")


# ========================
# ===== DB CONNECTION =====
# ========================

def get_db():
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    return conn


# =======================
# ===== DATA MODELS =====
# =======================

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str

class LoginRequest(BaseModel):
    username: str
    password: str

class MessageRequest(BaseModel):
    sender_id: int
    recipient_id: int
    content: str

class EditMessageRequest(BaseModel):
    user_id: int        # Must match the original sender
    new_content: str

class FriendRequest(BaseModel):
    requester_id: int
    receiver_id: int

class FriendRequestResponse(BaseModel):
    request_id: int
    action: str         # "accept" or "decline"
    user_id: int        # FIX: added so we can verify the responder is actually the receiver

class BlockRequest(BaseModel):
    blocker_id: int
    blocked_id: int


# ==============================
# ===== AUTH ENDPOINTS =====
# ==============================

@app.post("/register")
def register(data: RegisterRequest):
    """Register a new user account."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO users (username, email, password) VALUES (%s, %s, %s) RETURNING id",
            (data.username, data.email, data.password)
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
def login(data: LoginRequest):
    """Login with username and password."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT id, username, password FROM users WHERE username = %s",
            (data.username,)
        )
        user = cursor.fetchone()
        if not user or user[2] != data.password:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        return {"message": "Login successful", "user_id": user[0], "username": user[1]}
    finally:
        cursor.close()
        conn.close()


# ==============================
# ===== USER ENDPOINTS =====
# ==============================

@app.get("/users")
def get_users():
    """Get all registered users."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, username, email FROM users")
        rows = cursor.fetchall()
        users = [{"id": row[0], "username": row[1], "email": row[2]} for row in rows]
        return {"users": users}
    finally:
        cursor.close()
        conn.close()


@app.get("/users/search")
def search_users(query: str):
    """Search for users by username (partial match)."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT id, username, email FROM users WHERE username ILIKE %s",
            (f"%{query}%",)
        )
        rows = cursor.fetchall()
        users = [{"id": row[0], "username": row[1], "email": row[2]} for row in rows]
        return {"users": users}
    finally:
        cursor.close()
        conn.close()


@app.get("/users/{user_id}")
def get_user(user_id: int):
    """Get a specific user's profile by ID."""
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


# ==============================
# ===== MESSAGE ENDPOINTS =====
# ==============================

@app.post("/send-message")
def send_message(data: MessageRequest):
    """Send a direct message to another user."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        # Check sender has not been blocked by the recipient
        cursor.execute(
            "SELECT id FROM blocks WHERE blocker_id = %s AND blocked_id = %s",
            (data.recipient_id, data.sender_id)
        )
        if cursor.fetchone():
            raise HTTPException(status_code=403, detail="You cannot message this user")

        cursor.execute(
            """INSERT INTO messages (sender_id, recipient_id, content, is_read)
               VALUES (%s, %s, %s, FALSE) RETURNING id""",
            (data.sender_id, data.recipient_id, data.content)
        )
        message_id = cursor.fetchone()[0]
        conn.commit()
        return {"message": "Message sent successfully", "message_id": message_id}
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


# FIX: /messages/unread/{user_id} MUST be registered before /messages/{user_id}/{other_user_id}
# otherwise FastAPI matches "unread" as the user_id integer param and this route is never reached.

@app.get("/messages/unread/{user_id}")
def get_unread_count(user_id: int):
    """Get the number of unread messages per sender for a user."""
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
        unread = [{"sender_id": row[0], "unread_count": row[1]} for row in rows]
        total = sum(r["unread_count"] for r in unread)
        return {"unread_by_sender": unread, "total_unread": total}
    finally:
        cursor.close()
        conn.close()


@app.get("/messages/{user_id}/{other_user_id}")
def get_messages(user_id: int, other_user_id: int):
    """Get the full conversation between two users. Also marks received messages as read."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        # Mark messages sent TO user_id as read
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
                "id": row[0],
                "sender_id": row[1],
                "recipient_id": row[2],
                "content": row[3],
                "sent_at": row[4].isoformat() if row[4] else None,
                "is_read": row[5],
                "is_edited": row[6],
            }
            for row in rows
        ]
        return {"messages": messages}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


@app.put("/messages/{message_id}")
def edit_message(message_id: int, data: EditMessageRequest):
    """Edit a message. Only the original sender can edit it."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT sender_id FROM messages WHERE id = %s", (message_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        if row[0] != data.user_id:
            raise HTTPException(status_code=403, detail="You can only edit your own messages")
        cursor.execute(
            "UPDATE messages SET content = %s, is_edited = TRUE WHERE id = %s",
            (data.new_content, message_id)
        )
        conn.commit()
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
def delete_message(message_id: int, user_id: int):
    """Delete a message. Only the original sender can delete it."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT sender_id FROM messages WHERE id = %s", (message_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Message not found")
        if row[0] != user_id:
            raise HTTPException(status_code=403, detail="You can only delete your own messages")
        cursor.execute("DELETE FROM messages WHERE id = %s", (message_id,))
        conn.commit()
        return {"message": "Message deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()


# ================================
# ===== FRIENDSHIP ENDPOINTS =====
# ================================

@app.post("/friend-request")
def send_friend_request(data: FriendRequest):
    """Send a friend request to another user."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            """SELECT id FROM friendships
               WHERE (requester_id = %s AND receiver_id = %s)
                  OR (requester_id = %s AND receiver_id = %s)""",
            (data.requester_id, data.receiver_id, data.receiver_id, data.requester_id)
        )
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="Friend request already exists")
        cursor.execute(
            "INSERT INTO friendships (requester_id, receiver_id, status) VALUES (%s, %s, 'pending') RETURNING id",
            (data.requester_id, data.receiver_id)
        )
        request_id = cursor.fetchone()[0]
        conn.commit()
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
def respond_to_friend_request(data: FriendRequestResponse):
    """Accept or decline a friend request."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        # FIX: verify the user responding is actually the receiver of the request
        cursor.execute(
            "SELECT id FROM friendships WHERE id = %s AND receiver_id = %s",
            (data.request_id, data.user_id)
        )
        if not cursor.fetchone():
            raise HTTPException(status_code=403, detail="You can only respond to your own friend requests")

        if data.action == "accept":
            cursor.execute(
                "UPDATE friendships SET status = 'accepted' WHERE id = %s",
                (data.request_id,)
            )
        elif data.action == "decline":
            cursor.execute("DELETE FROM friendships WHERE id = %s", (data.request_id,))
        else:
            raise HTTPException(status_code=400, detail="Action must be 'accept' or 'decline'")
        conn.commit()
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
def remove_friend(friendship_id: int, user_id: int):
    """Remove a friend (unfriend)."""
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
def get_friends(user_id: int):
    """Get all friends for a user, with their last message preview."""
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
                "id": row[0],
                "username": row[1],
                "friendship_id": row[2],
                "last_message": row[3],
                "last_message_time": row[4].isoformat() if row[4] else None,
                "unread_count": row[5],
            }
            for row in rows
        ]
        return {"friends": friends}
    finally:
        cursor.close()
        conn.close()


@app.get("/pending-requests/{user_id}")
def get_pending_requests(user_id: int):
    """Get all incoming pending friend requests for a user."""
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
        requests = [
            {"request_id": row[0], "requester_id": row[1], "username": row[2]}
            for row in rows
        ]
        return {"requests": requests}
    finally:
        cursor.close()
        conn.close()


# ============================
# ===== BLOCK ENDPOINTS =====
# ============================

@app.post("/block")
def block_user(data: BlockRequest):
    """Block a user. Removes any existing friendship and prevents messaging."""
    conn = get_db()
    cursor = conn.cursor()
    try:
        # Remove any existing friendship
        cursor.execute(
            """DELETE FROM friendships
               WHERE (requester_id = %s AND receiver_id = %s)
                  OR (requester_id = %s AND receiver_id = %s)""",
            (data.blocker_id, data.blocked_id, data.blocked_id, data.blocker_id)
        )
        # Check not already blocked
        cursor.execute(
            "SELECT id FROM blocks WHERE blocker_id = %s AND blocked_id = %s",
            (data.blocker_id, data.blocked_id)
        )
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="User is already blocked")
        cursor.execute(
            "INSERT INTO blocks (blocker_id, blocked_id) VALUES (%s, %s)",
            (data.blocker_id, data.blocked_id)
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
def unblock_user(blocker_id: int, blocked_id: int):
    """Unblock a previously blocked user."""
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
def get_blocked_users(user_id: int):
    """Get the list of users blocked by a given user."""
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
        blocked = [{"id": row[0], "username": row[1]} for row in rows]
        return {"blocked_users": blocked}
    finally:
        cursor.close()
        conn.close()


@app.get("/")
def serve_frontend():
    return FileResponse("static/index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)