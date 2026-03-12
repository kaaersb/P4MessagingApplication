import psycopg2
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")

try:
    connection = psycopg2.connect(DATABASE_URL)
    print("Connection successful!")

    cursor = connection.cursor()
    cursor.execute("SELECT NOW();")
    result = cursor.fetchone()
    print("Current Time:", result)

    cursor.close()
    connection.close()
    print("Connection closed.")
except Exception as e:
    print(f"Failed to connect: {e}")