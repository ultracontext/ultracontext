"""UltraContext - The context API for AI agents."""

from .client import AsyncUltraContext, UltraContext
from .exceptions import UltraContextError, UltraContextHttpError
from .types import (
    AppendResponse,
    BatchDeleteResponse,
    BatchDeleteResult,
    Context,
    CreateContextResponse,
    DeleteResponse,
    DestroyResponse,
    GetContextResponse,
    ListContextsResponse,
    Message,
    UpdateResponse,
    Version,
)

__version__ = "1.0.1"
__all__ = [
    # clients
    "UltraContext",
    "AsyncUltraContext",
    # exceptions
    "UltraContextError",
    "UltraContextHttpError",
    # types
    "Context",
    "Message",
    "Version",
    "CreateContextResponse",
    "ListContextsResponse",
    "GetContextResponse",
    "AppendResponse",
    "UpdateResponse",
    "DeleteResponse",
    "DestroyResponse",
    "BatchDeleteResult",
    "BatchDeleteResponse",
]
