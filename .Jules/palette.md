## 2024-12-07 - Dynamic Accessibility Labels for State Buttons
**Learning:** For a single button that changes state (Idle/Listening/Speaking/Processing), using a dynamic `accessibilityLabel` that includes the state (e.g. "Voice Assistant listening") is more effective than just a static label + state attribute, as it immediately informs the user of the current context.
**Action:** Combine component name and state in `accessibilityLabel` for multi-state toggle buttons.
