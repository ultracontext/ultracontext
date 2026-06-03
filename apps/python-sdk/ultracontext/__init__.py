"""UltraContext - The context API for AI agents."""

from importlib.metadata import PackageNotFoundError, version

from .client import AsyncUltraContext, UltraContext
from .exceptions import UltraContextError, UltraContextHttpError
from .types import (
    AppendResponse,
    Context,
    CreateContextResponse,
    DeleteManyResponse,
    DeleteManyResult,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    Message,
    PermanentDeleteResponse,
    UpdateResponse,
    Version,
)

# read the installed package version so it can't drift from pyproject;
# fall back to the hardcoded version when running from an uninstalled tree
try:
    __version__ = version("ultracontext")
except PackageNotFoundError:
    __version__ = "1.4.0"
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
    "PermanentDeleteResponse",
    "DeleteManyResult",
    "DeleteManyResponse",
]
