"""
SQLite database management for storing raw and processed transcriptions
"""

import sqlite3
import re
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from config import config


def convert_timestamps_to_filename(content: str, filename: str) -> str:
    """Convert timestamp brackets like [0.00s -> 6.80s] to filename-based format.
    
    Args:
        content: The file content with timestamps
        filename: The source filename (without extension)
        
    Returns:
        Content with timestamps replaced by filename
    """
    # Remove file extension from filename for the bracket content
    name_without_ext = Path(filename).stem
    
    # Pattern matches timestamps like [0.00s -> 6.80s] or [0.00s->6.80s]
    timestamp_pattern = r'\[\d+\.?\d*s\s*->\s*\d+\.?\d*s\]'
    
    # Replace all timestamp brackets with the filename
    converted = re.sub(timestamp_pattern, f'[{name_without_ext}]', content)
    
    return converted


class TranscriptionDB:
    def __init__(self, db_path: str = None):
        """Initialize database connection"""
        if db_path is None:
            db_path = config.get("database_path")
        
        self.db_path = db_path
        self.conn = None
        self.init_database()
    
    def connect(self):
        """Create database connection"""
        try:
            self.conn = sqlite3.connect(self.db_path)
            self.conn.row_factory = sqlite3.Row  # Access columns by name
            return self.conn
        except sqlite3.Error as e:
            print(f"Database connection error: {e}")
            return None
    
    def close(self):
        """Close database connection"""
        if self.conn:
            self.conn.close()
    
    def init_database(self):
        """Initialize database tables if they don't exist"""
        conn = self.connect()
        if conn is None:
            return
        
        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        processed_table = config.get("processed_table")
        
        try:
            # Create raw transcriptions table
            cursor.execute(f"""
                CREATE TABLE IF NOT EXISTS {raw_table} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT UNIQUE NOT NULL,
                    content TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source_timestamp TEXT,
                    processed INTEGER DEFAULT 0,
                    deleted INTEGER DEFAULT 0
                )
            """)
            
            # Add columns if they don't exist (migration)
            cursor.execute(f"PRAGMA table_info({raw_table})")
            columns = [column[1] for column in cursor.fetchall()]
            if 'processed' not in columns:
                cursor.execute(f"ALTER TABLE {raw_table} ADD COLUMN processed INTEGER DEFAULT 0")
                print(f"Added 'processed' column to {raw_table}")
            if 'deleted' not in columns:
                cursor.execute(f"ALTER TABLE {raw_table} ADD COLUMN deleted INTEGER DEFAULT 0")
                print(f"Added 'deleted' column to {raw_table}")
            
            # Create processed transcriptions table
            cursor.execute(f"""
                CREATE TABLE IF NOT EXISTS {processed_table} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    raw_id INTEGER,
                    filename TEXT NOT NULL,
                    original_content TEXT,
                    edited_content TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    source_timestamp TEXT,
                    FOREIGN KEY (raw_id) REFERENCES {raw_table}(id)
                )
            """)

            # Remove legacy columns if they exist in processed table
            cursor.execute(f"PRAGMA table_info({processed_table})")
            processed_columns = [column[1] for column in cursor.fetchall()]
            legacy_columns = {'operation_reference', 'subject_name'}
            if any(col in processed_columns for col in legacy_columns):
                temp_table = f"{processed_table}_legacy_backup"
                cursor.execute(f"ALTER TABLE {processed_table} RENAME TO {temp_table}")

                cursor.execute(f"""
                    CREATE TABLE {processed_table} (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        raw_id INTEGER,
                        filename TEXT NOT NULL,
                        original_content TEXT,
                        edited_content TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        source_timestamp TEXT,
                        FOREIGN KEY (raw_id) REFERENCES {raw_table}(id)
                    )
                """)

                preserved_columns = [
                    'id',
                    'raw_id',
                    'filename',
                    'original_content',
                    'edited_content',
                    'created_at',
                    'processed_at',
                    'source_timestamp'
                ]
                column_csv = ", ".join(preserved_columns)
                cursor.execute(
                    f"INSERT INTO {processed_table} ({column_csv}) "
                    f"SELECT {column_csv} FROM {temp_table}"
                )
                cursor.execute(f"DROP TABLE {temp_table}")
                print(f"Removed legacy columns from {processed_table}: operation_reference, subject_name")
            
            # Create Singapore addresses table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS "singapore addresses" (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    address TEXT NOT NULL,
                    postal_code TEXT,
                    category TEXT,
                    lat REAL,
                    lng REAL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            # Create relevant SO report entries table (persisted row picks)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS relevant_so_report_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id TEXT,
                    filename TEXT,
                    line_index INTEGER,
                    display_datetime TEXT,
                    channel_name TEXT,
                    content_line TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)

            cursor.execute("""
                CREATE UNIQUE INDEX IF NOT EXISTS idx_relevant_so_report_unique
                ON relevant_so_report_entries (
                    record_id,
                    filename,
                    line_index,
                    display_datetime,
                    content_line
                )
            """)
            
            # Create index for fast searches
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_address_name ON "singapore addresses"(name)
            """)
            
            conn.commit()
            print(f"Database initialized: {self.db_path}")
        except sqlite3.Error as e:
            print(f"Database initialization error: {e}")
        finally:
            self.close()
    
    def add_raw_transcription(self, filename: str, content: str, source_timestamp: str = None) -> bool:
        """Add a new raw transcription"""
        conn = self.connect()
        if conn is None:
            return False
        
        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        
        try:
            created_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            cursor.execute(f"""
                INSERT INTO {raw_table} (filename, content, source_timestamp, created_at)
                VALUES (?, ?, ?, ?)
            """, (filename, content, source_timestamp, created_at))
            conn.commit()
            if config.get("debug_mode"):
                print(f"Added raw transcription: {filename}")
            return True
        except sqlite3.IntegrityError:
            if config.get("debug_mode"):
                print(f"Duplicate file skipped: {filename}")
            return False
        except sqlite3.Error as e:
            print(f"Error adding raw transcription: {e}")
            return False
        finally:
            self.close()

    def add_raw_and_mark_processed(self, filename: str, content: str, source_timestamp: str = None) -> bool:
        """Insert into raw and immediately move to processed in one transaction.

        This keeps a record in raw (processed=1) while also inserting into processed table.
        """
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        processed_table = config.get("processed_table")

        try:
            created_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

            cursor.execute(f"""
                INSERT INTO {raw_table} (filename, content, source_timestamp, created_at)
                VALUES (?, ?, ?, ?)
            """, (filename, content, source_timestamp, created_at))

            raw_id = cursor.lastrowid
            converted_content = convert_timestamps_to_filename(content, filename)
            processed_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

            cursor.execute(f"""
                INSERT INTO {processed_table}
                (raw_id, filename, original_content, edited_content, source_timestamp, created_at, processed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                raw_id,
                filename,
                converted_content,
                converted_content,
                source_timestamp,
                created_at,
                processed_at
            ))

            cursor.execute(f"UPDATE {raw_table} SET processed = 1 WHERE id = ?", (raw_id,))

            conn.commit()
            if config.get("debug_mode"):
                print(f"Added and marked processed: {filename}")
            return True
        except sqlite3.IntegrityError:
            if config.get("debug_mode"):
                print(f"Duplicate file skipped: {filename}")
            return False
        except sqlite3.Error as e:
            print(f"Error adding raw and processed transcription: {e}")
            return False
        finally:
            self.close()
    
    def get_raw_transcriptions(self) -> List[Dict]:
        """Get all unprocessed raw transcriptions"""
        conn = self.connect()
        if conn is None:
            return []
        
        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        
        try:
            cursor.execute(
                f"SELECT * FROM {raw_table} WHERE processed = 0 AND deleted = 0 ORDER BY filename DESC"
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            print(f"Error retrieving raw transcriptions: {e}")
            return []
        finally:
            self.close()

    def get_all_raw_transcriptions(self) -> List[Dict]:
        """Get all raw transcriptions (processed and unprocessed)"""
        conn = self.connect()
        if conn is None:
            return []

        cursor = conn.cursor()
        raw_table = config.get("raw_table")

        try:
            cursor.execute(f"SELECT * FROM {raw_table} ORDER BY created_at DESC")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            print(f"Error retrieving all raw transcriptions: {e}")
            return []
        finally:
            self.close()
    
    def get_raw_transcription(self, raw_id: int) -> Optional[Dict]:
        """Get a specific raw transcription by ID"""
        conn = self.connect()
        if conn is None:
            return None
        
        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        
        try:
            cursor.execute(f"SELECT * FROM {raw_table} WHERE id = ?", (raw_id,))
            row = cursor.fetchone()
            return dict(row) if row else None
        except sqlite3.Error as e:
            print(f"Error retrieving raw transcription: {e}")
            return None
        finally:
            self.close()
    
    def move_to_processed(self, raw_id: int, edited_content: str = None) -> bool:
        """Move transcription from raw to processed"""
        conn = self.connect()
        if conn is None:
            return False
        
        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        processed_table = config.get("processed_table")
        
        try:
            # Get raw transcription
            cursor.execute(f"SELECT * FROM {raw_table} WHERE id = ?", (raw_id,))
            row = cursor.fetchone()
            
            if not row:
                print(f"Raw transcription not found: {raw_id}")
                return False
            
            raw_data = dict(row)
            # Convert timestamp brackets to filename format when moving to processed
            original_content = raw_data['content']
            converted_content = convert_timestamps_to_filename(original_content, raw_data['filename'])
            edited = edited_content if edited_content else converted_content
            # Also convert edited_content if provided (in case it still has old timestamps)
            if edited_content:
                edited = convert_timestamps_to_filename(edited_content, raw_data['filename'])
            now_local = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
            
            # Insert into processed table
            cursor.execute(f"""
                INSERT INTO {processed_table} 
                (raw_id, filename, original_content, edited_content, source_timestamp, created_at, processed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                raw_id,
                raw_data['filename'],
                converted_content,
                edited,
                raw_data['source_timestamp'],
                raw_data['created_at'],
                now_local
            ))
            
            # Mark as processed in raw table
            cursor.execute(f"UPDATE {raw_table} SET processed = 1 WHERE id = ?", (raw_id,))
            
            conn.commit()
            if config.get("debug_mode"):
                print(f"Moved to processed: {raw_data['filename']}")
            return True
        except sqlite3.Error as e:
            print(f"Error moving to processed: {e}")
            return False
        finally:
            self.close()
    
    def get_processed_transcriptions(self) -> List[Dict]:
        """Get all processed transcriptions"""
        conn = self.connect()
        if conn is None:
            return []
        
        cursor = conn.cursor()
        processed_table = config.get("processed_table")
        
        try:
            cursor.execute(f"SELECT * FROM {processed_table} ORDER BY filename DESC")
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            print(f"Error retrieving processed transcriptions: {e}")
            return []
        finally:
            self.close()

    def update_processed_transcription(self, processed_id: int, edited_content: str) -> bool:
        """Update edited content for a processed transcription"""
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        processed_table = config.get("processed_table")

        try:
            cursor.execute(
                f"UPDATE {processed_table} SET edited_content = ? WHERE id = ?",
                (edited_content, processed_id)
            )
            conn.commit()
            return cursor.rowcount > 0
        except sqlite3.Error as e:
            print(f"Error updating processed transcription: {e}")
            return False
        finally:
            self.close()

    def delete_raw_transcription(self, raw_id: int) -> bool:
        """Delete a raw transcription by ID"""
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        raw_table = config.get("raw_table")

        try:
            cursor.execute(f"DELETE FROM {raw_table} WHERE id = ?", (raw_id,))
            conn.commit()
            return cursor.rowcount > 0
        except sqlite3.Error as e:
            print(f"Error deleting raw transcription: {e}")
            return False
        finally:
            self.close()

    def delete_all_raw_transcriptions(self) -> bool:
        """Delete all raw transcriptions"""
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        raw_table = config.get("raw_table")

        try:
            cursor.execute(f"DELETE FROM {raw_table}")
            conn.commit()
            if config.get("debug_mode"):
                print(f"Deleted all rows from {raw_table}")
            return True
        except sqlite3.Error as e:
            print(f"Error deleting all raw transcriptions: {e}")
            return False
        finally:
            self.close()

    def delete_all_processed_transcriptions(self) -> bool:
        """Delete all processed transcriptions"""
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        processed_table = config.get("processed_table")

        try:
            cursor.execute(f"DELETE FROM {processed_table}")
            conn.commit()
            if config.get("debug_mode"):
                print(f"Deleted all rows from {processed_table}")
            return True
        except sqlite3.Error as e:
            print(f"Error deleting all processed transcriptions: {e}")
            return False
        finally:
            self.close()

    def clear_all_data(self) -> bool:
        """Delete all transcription data (raw, processed, relevant SO entries).
        Singapore addresses reference data is preserved."""
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        raw_table = config.get("raw_table")
        processed_table = config.get("processed_table")

        try:
            cursor.execute(f"DELETE FROM {processed_table}")
            cursor.execute(f"DELETE FROM {raw_table}")
            cursor.execute("DELETE FROM relevant_so_report_entries")
            for table in (raw_table, processed_table, "relevant_so_report_entries"):
                cursor.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))
            conn.commit()
            if config.get("debug_mode"):
                print("Cleared all transcription data from the database")
            return True
        except sqlite3.Error as e:
            print(f"Error clearing all data: {e}")
            return False
        finally:
            self.close()

    def get_relevant_so_report_entries(self) -> List[Dict]:
        """Get persisted Relevant SO Report entries in insertion order."""
        conn = self.connect()
        if conn is None:
            return []

        cursor = conn.cursor()
        try:
            cursor.execute(
                """
                SELECT record_id, filename, line_index, display_datetime, channel_name, content_line
                FROM relevant_so_report_entries
                ORDER BY id ASC
                """
            )
            rows = cursor.fetchall()
            return [dict(row) for row in rows]
        except sqlite3.Error as e:
            print(f"Error retrieving relevant SO report entries: {e}")
            return []
        finally:
            self.close()

    def replace_relevant_so_report_entries(self, entries: List[Dict]) -> bool:
        """Replace all persisted Relevant SO Report entries with provided list."""
        conn = self.connect()
        if conn is None:
            return False

        cursor = conn.cursor()
        try:
            cursor.execute("DELETE FROM relevant_so_report_entries")

            for entry in entries:
                cursor.execute(
                    """
                    INSERT INTO relevant_so_report_entries
                    (record_id, filename, line_index, display_datetime, channel_name, content_line)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(entry.get('record_id') or ''),
                        str(entry.get('filename') or ''),
                        entry.get('line_index'),
                        str(entry.get('display_datetime') or ''),
                        str(entry.get('channel_name') or ''),
                        str(entry.get('content_line') or ''),
                    )
                )

            conn.commit()
            return True
        except sqlite3.Error as e:
            print(f"Error replacing relevant SO report entries: {e}")
            return False
        finally:
            self.close()
    
    def add_singapore_address(self, name: str, address: str, postal_code: str = None, category: str = None, lat: float = None, lng: float = None) -> bool:
        """Add a Singapore address to database"""
        conn = self.connect()
        if conn is None:
            return False
        
        cursor = conn.cursor()
        try:
            cursor.execute("""
                INSERT OR REPLACE INTO "singapore addresses" (name, address, postal_code, category, lat, lng)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (name.lower(), address, postal_code, category, lat, lng))
            conn.commit()
            return True
        except sqlite3.Error as e:
            print(f"Error adding address: {e}")
            return False
        finally:
            self.close()
    
    def search_singapore_address(self, query: str) -> Optional[Dict]:
        """Search for a Singapore address by name (case-insensitive)"""
        conn = self.connect()
        if conn is None:
            return None
        
        cursor = conn.cursor()
        try:
            # Exact match first
            cursor.execute("""
                SELECT name, address, postal_code, category FROM "singapore addresses"
                WHERE name = ?
            """, (query.lower(),))
            
            row = cursor.fetchone()
            if row:
                return {
                    'name': row[0],
                    'address': row[1],
                    'postal_code': row[2],
                    'category': row[3]
                }
            
            # Partial match if exact not found
            cursor.execute("""
                SELECT name, address, postal_code, category FROM "singapore addresses"
                WHERE name LIKE ?
                LIMIT 1
            """, (f"%{query.lower()}%",))
            
            row = cursor.fetchone()
            if row:
                return {
                    'name': row[0],
                    'address': row[1],
                    'postal_code': row[2],
                    'category': row[3]
                }
            
            return None
        except sqlite3.Error as e:
            print(f"Error searching address: {e}")
            return None
        finally:
            self.close()
    
