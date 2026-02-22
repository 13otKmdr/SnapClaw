"""
Intent Classification - Determines CHAT vs COMMAND with entity extraction
"""
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass
import re
from schemas.action_plan import IntentResult


@dataclass
class ClassificationPattern:
    """Pattern for intent classification."""
    keywords: List[str]
    intent: str
    system: str
    action: str
    entity_extractors: Dict[str, re.Pattern]


class IntentClassifier:
    """Classifies user utterances as CHAT, COMMAND, or AMBIGUOUS."""

    # Command patterns with their associated systems
    COMMAND_PATTERNS = [
        ClassificationPattern(
            keywords=["send", "message", "telegram", "tell", "text"],
            intent="telegram_send_message",
            system="telegram",
            action="send_message",
            entity_extractors={
                "recipient": re.compile(r"(?:to|tell)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)", re.I),
                "message": re.compile(r"(?:saying|that|message)\s+["']?(.+?)["']?(?:$|\sto\s)", re.I),
            }
        ),
        ClassificationPattern(
            keywords=["read", "messages", "check", "telegram", "chat"],
            intent="telegram_read_messages",
            system="telegram",
            action="read_messages",
            entity_extractors={
                "chat": re.compile(r"(?:from|in)\s+([A-Za-z\s]+?)(?:\s+chat)?(?:$|\s)", re.I),
                "limit": re.compile(r"(?:last|recent)\s+(\d+)", re.I),
            }
        ),
        ClassificationPattern(
            keywords=["search", "find", "look for", "telegram"],
            intent="telegram_search",
            system="telegram",
            action="search_messages",
            entity_extractors={
                "query": re.compile(r"(?:search|find|look for)\s+["']?(.+?)["']?(?:$|\sin)", re.I),
            }
        ),
        ClassificationPattern(
            keywords=["research", "analyze", "task", "agent zero", "agent 0"],
            intent="agent_zero_execute",
            system="agent_zero",
            action="execute_task",
            entity_extractors={
                "task": re.compile(r"(?:research|analyze|task)\s+(.+?)(?:$|\swith)", re.I),
            }
        ),
        ClassificationPattern(
            keywords=["execute", "run", "tool", "openclaw"],
            intent="openclaw_execute",
            system="openclaw",
            action="execute_tool",
            entity_extractors={
                "tool": re.compile(r"(?:execute|run)\s+(.+?)(?:$|\swith)", re.I),
            }
        ),
    ]

    # Chat indicators
    CHAT_INDICATORS = [
        "what", "how", "why", "when", "where", "who", "which",
        "explain", "describe", "tell me about", "can you help",
        "i think", "i feel", "in your opinion", "do you know",
        "weather", "time", "date", "joke", "story"
    ]

    # Ambiguity indicators
    AMBIGUITY_INDICATORS = [
        "it", "that", "this", "him", "her", "them", "the thing",
        "the stuff", "whatshisname", "you know"
    ]

    def __init__(self, confidence_threshold: float = 0.7):
        self.confidence_threshold = confidence_threshold

    def classify(self, utterance: str) -> IntentResult:
        """Classify utterance and extract entities."""
        utterance_lower = utterance.lower().strip()

        # Check for ambiguity first
        ambiguity_score = self._calculate_ambiguity(utterance_lower)
        if ambiguity_score > 0.5:
            return IntentResult(
                mode="AMBIGUOUS",
                confidence=1.0 - ambiguity_score,
                entities={"pronouns": self._extract_ambiguous_refs(utterance_lower)},
                raw_transcript=utterance
            )

        # Score command patterns
        best_match: Optional[Tuple[ClassificationPattern, float]] = None
        best_score = 0.0

        for pattern in self.COMMAND_PATTERNS:
            score = self._score_pattern(utterance_lower, pattern)
            if score > best_score:
                best_score = score
                best_match = (pattern, score)

        # Check for chat indicators
        chat_score = self._score_chat(utterance_lower)

        # Decision logic
        if best_match and best_score > self.confidence_threshold and best_score > chat_score:
            pattern, confidence = best_match
            entities = self._extract_entities(utterance, pattern)

            return IntentResult(
                mode="COMMAND",
                confidence=confidence,
                intent=pattern.intent,
                entities=entities,
                raw_transcript=utterance
            )
        elif chat_score > 0.3:
            return IntentResult(
                mode="CHAT",
                confidence=chat_score,
                raw_transcript=utterance
            )
        else:
            # Low confidence - classify as ambiguous
            return IntentResult(
                mode="AMBIGUOUS",
                confidence=best_score if best_match else 0.0,
                intent=best_match[0].intent if best_match else None,
                entities=self._extract_entities(utterance, best_match[0]) if best_match else {},
                raw_transcript=utterance
            )

    def _score_pattern(self, utterance: str, pattern: ClassificationPattern) -> float:
        """Score how well utterance matches a command pattern."""
        matches = sum(1 for kw in pattern.keywords if kw in utterance)
        return matches / len(pattern.keywords)

    def _score_chat(self, utterance: str) -> float:
        """Score how likely this is a chat message."""
        matches = sum(1 for ind in self.CHAT_INDICATORS if ind in utterance)
        return min(matches / 3.0, 1.0)  # Cap at 1.0

    def _calculate_ambiguity(self, utterance: str) -> float:
        """Calculate ambiguity score based on pronoun usage."""
        refs = self._extract_ambiguous_refs(utterance)
        return min(len(refs) * 0.3, 1.0)

    def _extract_ambiguous_refs(self, utterance: str) -> List[str]:
        """Extract ambiguous references from utterance."""
        return [ind for ind in self.AMBIGUITY_INDICATORS if f" {ind} " in f" {utterance} "]

    def _extract_entities(self, utterance: str, pattern: ClassificationPattern) -> Dict[str, Any]:
        """Extract entities using pattern's extractors."""
        entities = {}
        for name, regex in pattern.entity_extractors.items():
            match = regex.search(utterance)
            if match:
                entities[name] = match.group(1).strip()
        return entities
