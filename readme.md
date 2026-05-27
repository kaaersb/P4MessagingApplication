# P4 Messaging Application

A private messaging network built with FastAPI and PostgreSQL. Users can register, discover other users, manage a friends list through a request system, and exchange real-time direct messages.

## Features

- **User Authentication**: Registration and login with bcrypt password hashing, timing-safe comparisons, and server-side session management via `HttpOnly`/`Secure`/`SameSite=Strict` cookies.
- **Friendship System**: Send, accept, or decline friend requests. Friends list includes last-message preview and unread count per contact.
- **Blocking**: Block or unblock users; blocked users cannot send messages.
- **Private Messaging**: Direct messages between friends with full conversation history, read receipts, edit, and delete.
- **Real-time Updates**: WebSocket connections push new messages, edits, deletes, and read receipts instantly to connected clients. The WebSocket handshake is validated against the server-side session cookie.
- **User Discovery**: Search registered users by username (partial, case-insensitive match).
- **Security Hardening**: HTTPS enforcement, HSTS, CSP, rate limiting on auth/search/message endpoints, parameterised SQL queries, and HTML-escaped message content.

## Tech Stack

- **Backend**: FastAPI (Python)
- **Database**: PostgreSQL with `psycopg2`
- **Real-time**: WebSockets via FastAPI/Starlette
- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Authentication**: bcrypt + server-side session store (in-process dict; replace with Redis for multi-process deployments)
- **Environment Management**: `python-dotenv`

## Prerequisites

- Python 3.7+
- PostgreSQL database
- A `.env` file containing your database credentials

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/kaaersb/P4MessagingApplication.git
   cd P4MessagingApplication
   ```

2. **Install dependencies**:
   ```bash
   pip install fastapi psycopg2-binary python-dotenv uvicorn bcrypt
   ```

3. **Configure environment variables**:
   Create a `.env` file in the root directory:
   ```env
   DATABASE_URL=postgres://username:password@localhost:5432/your_database
   ```

4. **Database setup**:
   Run the following SQL to initialise the required tables:
   ```sql
   CREATE TABLE users (
       id SERIAL PRIMARY KEY,
       username TEXT UNIQUE NOT NULL,
       email TEXT UNIQUE NOT NULL,
       password TEXT NOT NULL
   );

   CREATE TABLE friendships (
       id SERIAL PRIMARY KEY,
       requester_id INTEGER REFERENCES users(id),
       receiver_id INTEGER REFERENCES users(id),
       status TEXT DEFAULT 'pending'
   );

   CREATE TABLE messages (
       id SERIAL PRIMARY KEY,
       sender_id INTEGER REFERENCES users(id),
       recipient_id INTEGER REFERENCES users(id),
       content TEXT NOT NULL,
       sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       is_read BOOLEAN DEFAULT FALSE,
       is_edited BOOLEAN DEFAULT FALSE
   );

   CREATE TABLE blocks (
       id SERIAL PRIMARY KEY,
       blocker_id INTEGER REFERENCES users(id),
       blocked_id INTEGER REFERENCES users(id),
       UNIQUE(blocker_id, blocked_id)
   );
   ```

## Running the Application

1. **Verify database connection**:
   ```bash
   python test_connection.py
   ```

2. **Start the server**:
   ```bash
   uvicorn main:app --reload
   ```
   > The app enforces HTTPS. For local development, run with a TLS proxy (e.g. [mkcert](https://github.com/FiloSottile/mkcert) + nginx) or temporarily remove `HTTPSRedirectMiddleware` from `main.py`.

3. **Access the app**:
   Navigate to `https://127.0.0.1:8000` (or your configured domain).

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register` | Register a new user |
| `POST` | `/login` | Log in and receive a session cookie |
| `POST` | `/logout` | Invalidate session and clear cookie |
| `GET` | `/users` | List all users (auth required) |
| `GET` | `/users/search?query=` | Search users by username |
| `GET` | `/users/{user_id}` | Get a user's profile |
| `POST` | `/send-message` | Send a direct message |
| `GET` | `/messages/{user_id}/{other_user_id}` | Fetch conversation history (marks as read) |
| `PUT` | `/messages/{message_id}` | Edit a sent message |
| `DELETE` | `/messages/{message_id}` | Delete a sent message |
| `GET` | `/messages/unread/{user_id}` | Get unread counts per sender |
| `POST` | `/friend-request` | Send a friend request |
| `POST` | `/friend-request/respond` | Accept or decline a request |
| `GET` | `/friends/{user_id}` | Get friends list with last-message preview |
| `DELETE` | `/friends/{friendship_id}` | Remove a friend |
| `GET` | `/pending-requests/{user_id}` | Get incoming pending friend requests |
| `POST` | `/block` | Block a user |
| `DELETE` | `/block` | Unblock a user |
| `GET` | `/blocked/{user_id}` | List blocked users |
| `WS` | `/ws/{user_id}` | WebSocket connection for real-time events |

## Project Structure

```
P4MessagingApplication/
├── main.py                  # FastAPI backend — all API and WebSocket endpoints
├── test_connection.py       # Utility script to verify PostgreSQL connectivity
├── .env                     # Database credentials (not committed)
└── static/
    ├── index.html           # Single-page app entry point
    ├── js/
    │   └── app.js           # Messaging UI logic and API interactions
    └── css/
        ├── base.css         # CSS custom properties, reset, shared components
        └── auth.css         # Welcome screen, login, and registration styles
```

## Security Notes

- Passwords are stored as bcrypt hashes; plaintext is never persisted.
- A constant-time dummy hash prevents username enumeration through login timing.
- All SQL queries use parameterised statements — no string interpolation.
- Message content is HTML-escaped at write time to prevent XSS.
- Sessions use 256-bit random tokens stored server-side; the client only holds an `HttpOnly` cookie.
- WebSocket connections are rejected unless the session cookie matches the requested `user_id`.
- Rate limits are applied per IP: 5 req/min on register, 10 req/min on login, 30 req/min on search, 60 req/min on send-message.
- Security headers set on every response: HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and a strict CSP.
- For multi-process or multi-server deployments, replace the in-process session dict and rate-limiter with Redis.ic and API interactions.
    * `css/`: Style sheets for the authentication and messaging interfaces.
