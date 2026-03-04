# P4 Messaging Application

A private messaging network built with FastAPI and PostgreSQL. This application allows users to register, find friends through a request system, and engage in private real-time conversations.

## Features

* **User Authentication**: Full registration and login system with session management.
* **Friendship System**: Send, accept, or decline friend requests to build a contact list.
* **Private Messaging**: Direct messaging between connected friends with message history.
* **Real-time Updates**: Frontend polling ensures new messages and friend requests appear without manual refreshing.
* **User Discovery**: Search for other registered users on the network by username.

## Tech Stack

* **Backend**: FastAPI (Python).
* **Database**: PostgreSQL with `psycopg2`.
* **Frontend**: Vanilla JavaScript, HTML5, and CSS3.
* **Environment Management**: `python-dotenv`.

## Prerequisites

* Python 3.7+
* PostgreSQL database
* A `.env` file containing your database credentials

## Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/kaaersb/P4MessagingApplication.git
    cd P4MessagingApplication
    ```

2.  **Install dependencies**:
    ```bash
    pip install fastapi psycopg2-binary python-dotenv uvicorn
    ```

3.  **Configure Environment Variables**:
    Create a `.env` file in the root directory and add your PostgreSQL connection string:
    ```env
    DATABASE_URL=postgres://username:password@localhost:5432/your_database
    ```

4.  **Database Setup**:
    Initialize your PostgreSQL database with the following table structures:
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
        receiver_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ```

## Running the Application

1.  **Verify Database Connection**:
    Run the included test script to ensure your `.env` configuration is correct:
    ```bash
    python test_connection.py
    ```

2.  **Start the Server**:
    ```bash
    uvicorn main:app --reload
    ```

3.  **Access the App**:
    Open your browser and navigate to `http://127.0.0.1:8000`.

## Project Structure

* `main.py`: The FastAPI backend containing API endpoints for users, friends, and messages.
* `test_connection.py`: Utility script to verify PostgreSQL connectivity.
* `static/`: Contains the frontend assets (HTML, CSS, and JS).
    * `js/messenger.js`: Handles the core messaging UI logic and API interactions.
    * `css/`: Style sheets for the authentication and messaging interfaces.