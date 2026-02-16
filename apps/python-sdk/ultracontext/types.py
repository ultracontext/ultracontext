"""UltraContext type definitions."""

from typing import Any, Dict, List, Optional, TypedDict


class Context(TypedDict):
    """Context object returned from list()."""

    id: str
    metadata: Dict[str, Any]
    created_at: str


class Message(TypedDict, total=False):
    """Message in a context."""

    id: str
    index: int
    role: str
    content: str
    metadata: Dict[str, Any]


class Version(TypedDict, total=False):
    """Version history entry."""

    version: int
    created_at: str
    operation: str
    affected: Optional[List[str]]
    metadata: Optional[Dict[str, Any]]


class CreateContextResponse(TypedDict):
    """Response from create()."""

    id: str
    metadata: Optional[Dict[str, Any]]
    created_at: str


class ListContextsResponse(TypedDict):
    """Response from get() when listing all contexts."""

    data: List[Context]


class GetContextResponse(TypedDict, total=False):
    """Response from get()."""

    data: List[Message]
    version: int
    versions: List[Version]


class AppendResponse(TypedDict):
    """Response from append()."""

    data: List[Message]
    version: int


class UpdateResponse(TypedDict):
    """Response from update()."""

    data: List[Message]
    version: int


class DeleteResponse(TypedDict):
    """Response from delete()."""

    data: List[Message]
    version: int
