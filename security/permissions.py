"""
Permission system for voice assistant actions
"""
from enum import Flag, auto
from typing import Set, Optional


class Permission(Flag):
    """Granular permissions for voice assistant actions."""
    TELEGRAM_READ = auto()
    TELEGRAM_SEND_CONTACT = auto()
    TELEGRAM_SEND_GROUP = auto()
    TELEGRAM_SEND_PUBLIC = auto()
    TELEGRAM_DELETE = auto()
    AGENT_ZERO_EXECUTE = auto()
    AGENT_ZERO_ADMIN = auto()
    OPENCLAW_EXECUTE = auto()
    OPENCLAW_ADMIN = auto()
    SYSTEM_CONFIG = auto()

    # Common combinations
    BASIC = TELEGRAM_READ | TELEGRAM_SEND_CONTACT | AGENT_ZERO_EXECUTE | OPENCLAW_EXECUTE
    POWER_USER = BASIC | TELEGRAM_SEND_GROUP
    ADMIN = POWER_USER | TELEGRAM_SEND_PUBLIC | TELEGRAM_DELETE | AGENT_ZERO_ADMIN | OPENCLAW_ADMIN | SYSTEM_CONFIG


class PermissionSet:
    """Role-based permission configuration."""

    ROLES = {
        "user": Permission.BASIC,
        "power_user": Permission.POWER_USER,
        "admin": Permission.ADMIN,
    }

    def __init__(self, role: str = "user", custom_permissions: Optional[Permission] = None):
        if custom_permissions:
            self.permissions = custom_permissions
        else:
            self.permissions = self.ROLES.get(role, Permission.BASIC)

    def can(self, permission: Permission) -> bool:
        """Check if permission is granted."""
        return bool(self.permissions & permission)

    def check_or_raise(self, permission: Permission) -> None:
        """Raise PermissionError if permission not granted."""
        if not self.can(permission):
            raise PermissionError(f"Missing permission: {permission.name}")

    def grant(self, permission: Permission) -> None:
        """Grant additional permission."""
        self.permissions |= permission

    def revoke(self, permission: Permission) -> None:
        """Revoke permission."""
        self.permissions &= ~permission


def get_permission_for_system(system: str, action: str) -> Permission:
    """Map system+action to required permission."""
    mapping = {
        ("telegram", "read"): Permission.TELEGRAM_READ,
        ("telegram", "send_contact"): Permission.TELEGRAM_SEND_CONTACT,
        ("telegram", "send_group"): Permission.TELEGRAM_SEND_GROUP,
        ("telegram", "send_public"): Permission.TELEGRAM_SEND_PUBLIC,
        ("telegram", "delete"): Permission.TELEGRAM_DELETE,
        ("agent_zero", "execute"): Permission.AGENT_ZERO_EXECUTE,
        ("agent_zero", "admin"): Permission.AGENT_ZERO_ADMIN,
        ("openclaw", "execute"): Permission.OPENCLAW_EXECUTE,
        ("openclaw", "admin"): Permission.OPENCLAW_ADMIN,
    }
    return mapping.get((system, action), Permission.SYSTEM_CONFIG)
