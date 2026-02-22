"""
Policy Validator - Enforces confirmation rules for actions
"""
from typing import Dict, Any, Optional, List, Set
from dataclasses import dataclass, field


@dataclass
class PolicyRule:
    """Rule for determining if action requires confirmation."""
    name: str
    description: str
    condition: callable
    confirmation_prompt: Optional[str] = None


class PolicyValidator:
    """Validates actions against security policies."""

    DEFAULT_CONFIRMATION_RULES = [
        # Telegram rules
        PolicyRule(
            name="new_telegram_recipient",
            description="Sending to a new Telegram contact",
            condition=lambda params, ctx: (
                params.get("system") == "telegram" and
                params.get("action") == "send_message" and
                params.get("recipient_type") == "new_contact" and
                params.get("recipient_name") not in ctx.get("known_contacts", set())
            ),
            confirmation_prompt="This is a new recipient. Send message to {recipient_name}?"
        ),
        PolicyRule(
            name="large_telegram_group",
            description="Sending to large Telegram group",
            condition=lambda params, ctx: (
                params.get("system") == "telegram" and
                params.get("action") == "send_message" and
                params.get("group_size", 0) > 50
            ),
            confirmation_prompt="This group has {group_size} members. Confirm sending?"
        ),
        PolicyRule(
            name="telegram_public_post",
            description="Posting to public channel",
            condition=lambda params, ctx: (
                params.get("system") == "telegram" and
                params.get("channel_type") == "public"
            ),
            confirmation_prompt="This will be visible to everyone. Continue?"
        ),
        PolicyRule(
            name="telegram_delete",
            description="Deleting Telegram messages",
            condition=lambda params, ctx: (
                params.get("system") == "telegram" and
                params.get("action") == "delete"
            ),
            confirmation_prompt="This action cannot be undone. Delete message(s)?"
        ),
        # Agent Zero rules
        PolicyRule(
            name="agent_zero_admin",
            description="Agent Zero admin operations",
            condition=lambda params, ctx: (
                params.get("system") == "agent_zero" and
                params.get("action") in ["admin", "config", "credentials"]
            ),
            confirmation_prompt="This modifies Agent Zero configuration. Continue?"
        ),
        # OpenClaw rules
        PolicyRule(
            name="openclaw_remote_modify",
            description="OpenClaw remote system modification",
            condition=lambda params, ctx: (
                params.get("system") == "openclaw" and
                params.get("target_remote", False) and
                params.get("action") in ["write", "delete", "execute"]
            ),
            confirmation_prompt="This modifies a remote system. Continue?"
        ),
        # Generic dangerous patterns
        PolicyRule(
            name="credential_change",
            description="Changing credentials or API keys",
            condition=lambda params, ctx: (
                any(kw in str(params).lower() for kw in ["password", "credential", "api_key", "secret", "token"])
                and params.get("action") in ["update", "change", "delete", "rotate"]
            ),
            confirmation_prompt="This involves credentials. Confirm action?"
        ),
        PolicyRule(
            name="financial_transaction",
            description="Financial transactions",
            condition=lambda params, ctx: (
                any(kw in str(params).lower() for kw in ["send money", "payment", "transfer", "withdraw"])
            ),
            confirmation_prompt="This involves money. Confirm transaction?"
        ),
    ]

    def __init__(self, custom_rules: List[PolicyRule] = None):
        self.rules = custom_rules or self.DEFAULT_CONFIRMATION_RULES
        self._known_contacts: Set[str] = set()
        self._whitelisted_targets: Set[str] = set()

    def requires_confirmation(self, action_plan: Dict[str, Any]) -> bool:
        """Check if action requires user confirmation."""
        context = {
            "known_contacts": self._known_contacts,
            "whitelisted_targets": self._whitelisted_targets,
        }

        for target in action_plan.get("targets", []):
            params = {
                "system": target.get("system"),
                "action": target.get("action"),
                **action_plan.get("parameters", {})
            }

            for rule in self.rules:
                if rule.condition(params, context):
                    return True

        return False

    def get_confirmation_prompt(self, action_plan: Dict[str, Any]) -> Optional[str]:
        """Get the confirmation prompt for an action."""
        context = {
            "known_contacts": self._known_contacts,
            "whitelisted_targets": self._whitelisted_targets,
        }

        for target in action_plan.get("targets", []):
            params = {
                "system": target.get("system"),
                "action": target.get("action"),
                **action_plan.get("parameters", {})
            }

            for rule in self.rules:
                if rule.condition(params, context) and rule.confirmation_prompt:
                    return rule.confirmation_prompt.format(**params, **context)

        return "This action requires confirmation. Proceed?"

    def is_safe(self, action_plan: Dict[str, Any]) -> bool:
        """Check if action is safe to execute (passes all policy checks)."""
        # Check for blocked patterns
        blocked_patterns = [
            "ignore previous",
            "system override",
            "delete all",
            "rm -rf",
            "grant all permissions",
            "disable security",
        ]

        action_str = str(action_plan).lower()
        for pattern in blocked_patterns:
            if pattern in action_str:
                return False

        return True

    def add_known_contact(self, name: str) -> None:
        """Add contact to known contacts (no confirmation needed)."""
        self._known_contacts.add(name.lower())

    def whitelist_target(self, target: str) -> None:
        """Whitelist a target (no confirmation for modifications)."""
        self._whitelisted_targets.add(target)
