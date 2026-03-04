## 2024-03-04 - [Destructive Actions Need Confirmation]
**Learning:** In live voice sessions and chat interfaces, destructive actions like clearing messages can cause significant data loss if triggered accidentally.
**Action:** Always wrap destructive actions (like delete or clear) in a confirmation `Alert.alert` with a 'destructive' style to prevent accidental data loss.
