import psycopg2
from dotenv import load_dotenv
import os

load_dotenv()

try:
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    cursor = conn.cursor()
    cursor.execute("SELECT version();")
    result = cursor.fetchone()
    print("✅ Connection successful!")
    print(f"PostgreSQL version: {result[0]}")
    cursor.close()
    conn.close()
except Exception as e:
    print(f"❌ Connection failed: {e}")