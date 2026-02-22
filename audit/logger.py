"""
Audit Logger - Immutable audit log for all executed actions
"""
import sqlite3
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, List
import uuid


class AuditLogger:
    """Immutable audit log for all executed actions."""

    SCHEMA = """
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        user_utterance TEXT NOT NULL,
        parsed_intent TEXT,
        confidence REAL,
        action_plan TEXT,
        tool_calls TEXT,
        tool_responses TEXT,
        success BOOLEAN,
        error_message TEXT,
        confirmation_given BOOLEAN,
        duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_trace_id ON audit_log(trace_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_intent ON audit_log(parsed_intent);
    """

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.executescript(self.SCHEMA)
        self.conn.commit()

    def log_action(
        self,
        trace_id: str,
        user_utterance: str,
        action_plan: Dict[str, Any],
        tool_calls: List[Dict[str, Any]],
        tool_responses: List[Dict[str, Any]],
        success: bool,
        error: Optional[str] = None,
        confirmation_given: bool = False,
        duration_ms: int = 0
    ) -> int:
        """Log an executed action. Returns log ID."""
        cursor = self.conn.execute(
            """INSERT INTO audit_log 
               (trace_id, timestamp, user_utterance, parsed_intent, confidence,
                action_plan, tool_calls, tool_responses, success, error_message,
                confirmation_given, duration_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                trace_id,
                datetime.utcnow().isoformat(),
                user_utterance,
                action_plan.get("intent"),
                action_plan.get("confidence"),
                json.dumps(action_plan),
                json.dumps(tool_calls),
                json.dumps(tool_responses),
                success,
                error,
                confirmation_given,
                duration_ms
            )
        )
        self.conn.commit()
        return cursor.lastrowid

    def get_recent(self, limit: int = 100) -> List[Dict[str, Any]]:
        """Get recent audit entries."""
        cursor = self.conn.execute(
            "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?",
            (limit,)
        )
        columns = [desc[0] for desc in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def search(
        self,
        intent: Optional[str] = None,
        success: Optional[bool] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """Search audit log with filters."""
        query = "SELECT * FROM audit_log WHERE 1=1"
        params = []

        if intent:
            query += " AND parsed_intent LIKE ?"
            params.append(f"%{intent}%")
        if success is not None:
            query += " AND success = ?"
            params.append(success)
        if start_date:
            query += " AND timestamp >= ?"
            params.append(start_date)
        if end_date:
            query += " AND timestamp <= ?"
            params.append(end_date)

        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        cursor = self.conn.execute(query, params)
        columns = [desc[0] for desc in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def get_stats(self, days: int = 7) -> Dict[str, Any]:
        """Get statistics for recent activity."""
        cursor = self.conn.execute(
            """SELECT 
                COUNT(*) as total_actions,
                SUM(CASE WHEN success THEN 1 ELSE 0 END) as successful,
                AVG(confidence) as avg_confidence,
                AVG(duration_ms) as avg_duration_ms,
                parsed_intent,
                DATE(timestamp) as date
               FROM audit_log
               WHERE timestamp >= datetime('now', ?)
               GROUP BY parsed_intent, DATE(timestamp)
               ORDER BY date DESC""",
            (f'-{days} days',)
        )

        return {
            "period_days": days,
            "breakdown": [
                {
                    "intent": row[4],
                    "date": row[5],
                    "total": row[0],
                    "successful": row[1],
                    "avg_confidence": row[2],
                    "avg_duration_ms": row[3]
                }
                for row in cursor.fetchall()
            ]
        }

    def close(self):
        """Close database connection."""
        self.conn.close()
