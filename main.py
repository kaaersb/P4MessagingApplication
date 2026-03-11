from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()

# Database connection
def get_db():
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    return conn

# =======================
# ===== DATA MODELS =====
# =======================


# Register a new user
class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str

# Login to a user profile
class LoginRequest(BaseModel):
    username: str
    password: str

# Send a message
class MessageRequest(BaseModel):
    sender_id: int
    recipient_id: int
    content: str


# =========================
# ===== FRIEND MODELS =====
# =========================
class FriendRequest(BaseModel):
    requester_id: int
    receiver_id: int

class FriendRequestResponse(BaseModel):
    request_id: int
    action: str  # "accept" or "decline"

# =====================
# ===== ENDPOINTS =====
# =====================

# Register end point
@app.post("/register")
def register(data: RegisterRequest):
    conn = get_db()                     # Connection the Database
    cursor = conn.cursor()          # cursor executes the command sent to the database
    try:
        cursor.execute(
            "INSERT INTO users (username, email, password) VALUES (%s, %s, %s) RETURNING id", # Three string value for username, email and password
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


# Login endpoint
@app.post("/login")
def login(data: LoginRequest):
    conn = get_db()                     # Database connection
    cursor = conn.cursor()          # cursor executes the commands send to the database
    try:
        cursor.execute(
            "SELECT id, username, password FROM users WHERE username = %s",
            (data.username,)
        )
        user = cursor.fetchone()
        if not user or user[2] != data.password:    # The user[2] indicates the third position in the row in the database
            raise HTTPException(status_code=401, detail="Invalid username or password")
        return {"message": "Login successful", "user_id": user[0], "username": user[1]}
    finally:
        cursor.close()
        conn.close()

# Get all users
@app.get("/users")
def get_users():
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id, username, password FROM users")
        rows = cursor.fetchall()
        users = [{"id": row[0], "username": row[1], "email": row[2]} for row in rows]
        return {"users": users}
    finally:
        cursor.close()
        conn.close()


# ==============================
# =====  MESSAGE ENDPOINTS =====
# ==============================

# Send a message endpoint
@app.post("/send-message")
def send_message(data: MessageRequest):
    conn = get_db()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO messages (sender_id, recipient_id, content) VALUES (%s, %s, %s) RETURNING id",
            (data.sender_id, data.recipient_id, data.content)
        )
        message_id = cursor.fetchone()[0]
        conn.commit()
        return {"message": "Message sent successfully", "message_id": message_id}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        cursor.close()
        conn.close()



# Get messages between uses endpoint
# Get conversation between two users
@app.get("/messages/{user_id}/{other_user_id}")
def get_messages(user_id: int, other_user_id: int):
    conn = get_db()
    operator = conn.cursor()
    try:
        operator.execute(
            """
            SELECT id, sender_id, receiver_id, content, sent_at
            FROM messages
            WHERE (sender_id = %s AND receiver_id = %s)
               OR (sender_id = %s AND receiver_id = %s)
            ORDER BY sent_at ASC
            """,
            (user_id, other_user_id, other_user_id, user_id)
        )
        rows = operator.fetchall()
        messages = [
            {
                "id": row[0],
                "sender_id": row[1],
                "receiver_id": row[2],
                "content": row[3],
                "sent_at": row[4]
            }
            for row in rows
        ]
        return {"messages": messages}
    finally:
        operator.close()
        conn.close()

# ================================
# ===== FRIENDSHIP ENDPOINTS =====
# ================================

@app.post("/friend-request")
def send_friend_request(data: FriendRequest):
    conn = get_db()
    operator = conn.cursor()
    try:
        # Check if request already exists
        operator.execute(
            """SELECT id FROM friendships 
               WHERE (requester_id = %s AND receiver_id = %s)
               OR (requester_id = %s AND receiver_id = %s)""",
            (data.requester_id, data.receiver_id, data.receiver_id, data.requester_id)
        )
        if operator.fetchone():
            raise HTTPException(status_code=400, detail="Friend request already exists")
        operator.execute(
            "INSERT INTO friendships (requester_id, receiver_id, status) VALUES (%s, %s, 'pending') RETURNING id",
            (data.requester_id, data.receiver_id)
        )
        request_id = operator.fetchone()[0]
        conn.commit()
        return {"message": "Friend request sent", "request_id": request_id}
    except HTTPException:
        raise
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        operator.close()
        conn.close()

@app.post("/friend-request/respond")
def respond_to_friend_request(data: FriendRequestResponse):
    conn = get_db()
    operator = conn.cursor()
    try:
        if data.action == "accept":
            operator.execute(
                "UPDATE friendships SET status = 'accepted' WHERE id = %s",
                (data.request_id,)
            )
        elif data.action == "decline":
            operator.execute(
                "DELETE FROM friendships WHERE id = %s",
                (data.request_id,)
            )
        conn.commit()
        return {"message": f"Friend request {data.action}ed"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        operator.close()
        conn.close()

@app.get("/friends/{user_id}")
def get_friends(user_id: int):
    conn = get_db()
    operator = conn.cursor()
    try:
        operator.execute(
            """
            SELECT 
                u.id, u.username,
                f.id as friendship_id,
                (
                    SELECT content FROM messages
                    WHERE (sender_id = u.id AND receiver_id = %s)
                       OR (sender_id = %s AND receiver_id = u.id)
                    ORDER BY sent_at DESC LIMIT 1
                ) as last_message,
                (
                    SELECT sent_at FROM messages
                    WHERE (sender_id = u.id AND receiver_id = %s)
                       OR (sender_id = %s AND receiver_id = u.id)
                    ORDER BY sent_at DESC LIMIT 1
                ) as last_message_time
            FROM friendships f
            JOIN users u ON (
                CASE WHEN f.requester_id = %s THEN f.receiver_id ELSE f.requester_id END = u.id
            )
            WHERE (f.requester_id = %s OR f.receiver_id = %s)
              AND f.status = 'accepted'
            ORDER BY last_message_time DESC NULLS LAST
            """,
            (user_id, user_id, user_id, user_id, user_id, user_id, user_id)
        )
        rows = operator.fetchall()
        friends = [
            {
                "id": row[0],
                "username": row[1],
                "friendship_id": row[2],
                "last_message": row[3],
                "last_message_time": row[4].isoformat() if row[4] else None
            }
            for row in rows
        ]
        return {"friends": friends}
    finally:
        operator.close()
        conn.close()

@app.get("/pending-requests/{user_id}")
def get_pending_requests(user_id: int):
    conn = get_db()
    operator = conn.cursor()
    try:
        operator.execute(
            """
            SELECT f.id, u.id as requester_id, u.username
            FROM friendships f
            JOIN users u ON f.requester_id = u.id
            WHERE f.receiver_id = %s AND f.status = 'pending'
            """,
            (user_id,)
        )
        rows = operator.fetchall()
        requests = [
            {"request_id": row[0], "requester_id": row[1], "username": row[2]}
            for row in rows
        ]
        return {"requests": requests}
    finally:
        operator.close()
        conn.close()

# --- Serve frontend ---
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def serve_frontend():
    return FileResponse("static/index.html")
@app.get("/login.html")
def serve_login():
    return FileResponse("static/login.html")
@app.get("/register.html")
def serve_register():
    return FileResponse("static/register.html")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)