"""UltraContext exceptions."""

from typing import Optional


class UltraContextError(Exception):
    """Base exception for UltraContext."""

    pass


class UltraContextHttpError(UltraContextError):
    """HTTP error from UltraContext API."""

    def __init__(self, message: str, status: int, url: str, body: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.url = url
        self.body = body
