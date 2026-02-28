## 2024-05-17 - Icon-only buttons lack ARIA labels
**Learning:** React Native's `TouchableOpacity` doesn't enforce accessibility labels by default. Several critical actions (Settings, Delete, Send) in `HomeScreen.tsx` are icon-only and invisible to screen readers. Destructive actions also lacked confirmations.
**Action:** Always add `accessibilityRole="button"` and `accessibilityLabel` to icon-only `TouchableOpacity` components, and confirmation alerts for destructive actions.
