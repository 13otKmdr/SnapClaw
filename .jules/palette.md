## 2025-03-03 - Prevent data loss on destructive actions
**Learning:** Found an unprotected destructive action (`clearMessages` via a "trash" icon button) where users could accidentally delete chat histories without confirmation.
**Action:** Always wrap destructive UI actions in a confirmation `Alert.alert` to prevent accidental data loss.
