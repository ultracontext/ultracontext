"""UltraContext API client."""

from typing import Any, Dict, List, Optional, Union, overload

import httpx

from .exceptions import UltraContextHttpError
from .types import (
    AppendResponse,
    CompressResponse,
    CreateContextResponse,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    UncompressResponse,
    UpdateResponse,
)


class _BaseClient:
    """Base client with shared config."""

    DEFAULT_BASE_URL = "https://api.ultracontext.ai"
    DEFAULT_TIMEOUT = 30.0

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        headers: Optional[Dict[str, str]] = None,
    ):
        self._api_key = api_key
        self._base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout or self.DEFAULT_TIMEOUT
        self._headers = headers or {}

    def _build_headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json", **self._headers}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers


class UltraContext(_BaseClient):
    """Sync UltraContext API client."""

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
    ) -> Any:
        """Make HTTP request."""

        # filter None values
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        url = f"{self._base_url}{path}"

        with httpx.Client(timeout=self._timeout) as client:
            response = client.request(
                method,
                url,
                params=params,
                json=json,
                headers=self._build_headers(),
            )

        # handle errors
        if not response.is_success:
            raise UltraContextHttpError(
                f"HTTP {response.status_code}: {response.text}",
                status=response.status_code,
                url=url,
                body=response.text,
            )

        # handle empty response
        if response.status_code == 204 or not response.content:
            return None

        return response.json()

    # --- Methods ---

    def create(
        self,
        *,
        from_: Optional[str] = None,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CreateContextResponse:
        """
        Create new context or fork from existing.

        Args:
            from_: Source context ID to fork from
            version: Fork from specific version
            at: Fork messages 0 through this index
            before: Fork point-in-time state before timestamp
            metadata: Context metadata
        """
        body: Dict[str, Any] = {}
        if from_ is not None:
            body["from"] = from_
        if version is not None:
            body["version"] = version
        if at is not None:
            body["at"] = at
        if before is not None:
            body["before"] = before
        if metadata is not None:
            body["metadata"] = metadata

        return self._request("POST", "/contexts", json=body or None)

    @overload
    def get(self, *, limit: Optional[int] = None) -> ListContextsResponse: ...

    @overload
    def get(
        self,
        context_id: str,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
    ) -> GetContextResponse: ...

    def get(
        self,
        context_id: Optional[str] = None,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
        limit: Optional[int] = None,
    ) -> Union[GetContextResponse, ListContextsResponse]:
        """
        Get context by ID, or list all contexts.

        Args:
            context_id: Context ID (omit to list all)
            version: Specific version to retrieve
            at: Return messages 0 through this index
            before: Point-in-time state before timestamp
            history: Include version history
            limit: Max contexts when listing (default 20)
        """
        # list all contexts
        if context_id is None:
            params = {"limit": limit} if limit else None
            return self._request("GET", "/contexts", params=params)

        # get single context
        params: Dict[str, Any] = {}
        if version is not None:
            params["version"] = version
        if at is not None:
            params["at"] = at
        if before is not None:
            params["before"] = before
        if history is not None:
            params["history"] = history

        return self._request("GET", f"/contexts/{context_id}", params=params or None)

    def append(
        self,
        context_id: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
    ) -> AppendResponse:
        """
        Append messages to context.

        Args:
            context_id: Context ID
            data: Single message or list of messages
        """
        items = data if isinstance(data, list) else [data]
        return self._request("POST", f"/contexts/{context_id}", json=items)

    def update(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]] = None,
        *,
        id: Optional[str] = None,
        index: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **fields: Any,
    ) -> UpdateResponse:
        """
        Update message(s) by id or index.

        Args:
            context_id: Context ID
            updates: List of updates for batch mode (each dict has id/index + fields)
            id: Message ID to update (single mode)
            index: Message index to update, 0=first, -1=last (single mode)
            metadata: Version metadata for audit trail
            **fields: Fields to update on the message (single mode)
        """
        # batch mode
        if updates is not None:
            body: Dict[str, Any] = {"updates": updates}
            if metadata:
                body["metadata"] = metadata
            return self._request("PATCH", f"/contexts/{context_id}", json=body)

        # single mode
        body = {**fields}
        if id is not None:
            body["id"] = id
        if index is not None:
            body["index"] = index

        # wrap with version metadata if provided
        if metadata:
            body = {"updates": [body], "metadata": metadata}

        return self._request("PATCH", f"/contexts/{context_id}", json=body)

    def delete(
        self,
        context_id: str,
        ids: Union[str, int, List[Union[str, int]]],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> DeleteResponse:
        """
        Delete messages by id(s) or index(es).

        Args:
            context_id: Context ID
            ids: Message ID, index, or list of IDs/indexes
            metadata: Version metadata for audit trail
        """
        items = ids if isinstance(ids, list) else [ids]
        body: Dict[str, Any] = {"ids": items}
        if metadata:
            body["metadata"] = metadata

        return self._request("DELETE", f"/contexts/{context_id}", json=body)

    def compress(
        self,
        context_id: str,
        *,
        preserve: Optional[List[str]] = None,
        mode: Optional[str] = None,
        recency_window: Optional[int] = None,
    ) -> CompressResponse:
        """
        Compress a context's messages.

        Args:
            context_id: Context ID
            preserve: Roles to preserve verbatim (default: ['system'])
            mode: 'lossless' or 'lossy'
            recency_window: Number of recent messages to preserve (default: 4)
        """
        body: Dict[str, Any] = {}
        if preserve is not None:
            body["preserve"] = preserve
        if mode is not None:
            body["mode"] = mode
        if recency_window is not None:
            body["recencyWindow"] = recency_window
        return self._request("POST", f"/contexts/{context_id}/compress", json=body or None)

    def uncompress(
        self,
        context_id: str,
        *,
        version: Optional[int] = None,
    ) -> UncompressResponse:
        """
        Uncompress a context back to its original messages.

        Args:
            context_id: Context ID
            version: Version to uncompress to
        """
        body: Dict[str, Any] = {}
        if version is not None:
            body["version"] = version
        return self._request("POST", f"/contexts/{context_id}/uncompress", json=body or None)


class AsyncUltraContext(_BaseClient):
    """Async UltraContext API client."""

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
    ) -> Any:
        """Make async HTTP request."""

        # filter None values
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        url = f"{self._base_url}{path}"

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.request(
                method,
                url,
                params=params,
                json=json,
                headers=self._build_headers(),
            )

        # handle errors
        if not response.is_success:
            raise UltraContextHttpError(
                f"HTTP {response.status_code}: {response.text}",
                status=response.status_code,
                url=url,
                body=response.text,
            )

        # handle empty response
        if response.status_code == 204 or not response.content:
            return None

        return response.json()

    # --- Methods ---

    async def create(
        self,
        *,
        from_: Optional[str] = None,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CreateContextResponse:
        """Create new context or fork from existing."""
        body: Dict[str, Any] = {}
        if from_ is not None:
            body["from"] = from_
        if version is not None:
            body["version"] = version
        if at is not None:
            body["at"] = at
        if before is not None:
            body["before"] = before
        if metadata is not None:
            body["metadata"] = metadata

        return await self._request("POST", "/contexts", json=body or None)

    @overload
    async def get(self, *, limit: Optional[int] = None) -> ListContextsResponse: ...

    @overload
    async def get(
        self,
        context_id: str,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
    ) -> GetContextResponse: ...

    async def get(
        self,
        context_id: Optional[str] = None,
        *,
        version: Optional[int] = None,
        at: Optional[int] = None,
        before: Optional[str] = None,
        history: Optional[bool] = None,
        limit: Optional[int] = None,
    ) -> Union[GetContextResponse, ListContextsResponse]:
        """Get context by ID, or list all contexts."""

        # list all contexts
        if context_id is None:
            params = {"limit": limit} if limit else None
            return await self._request("GET", "/contexts", params=params)

        # get single context
        params: Dict[str, Any] = {}
        if version is not None:
            params["version"] = version
        if at is not None:
            params["at"] = at
        if before is not None:
            params["before"] = before
        if history is not None:
            params["history"] = history

        return await self._request("GET", f"/contexts/{context_id}", params=params or None)

    async def append(
        self,
        context_id: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
    ) -> AppendResponse:
        """Append messages to context."""
        items = data if isinstance(data, list) else [data]
        return await self._request("POST", f"/contexts/{context_id}", json=items)

    async def update(
        self,
        context_id: str,
        updates: Optional[List[Dict[str, Any]]] = None,
        *,
        id: Optional[str] = None,
        index: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **fields: Any,
    ) -> UpdateResponse:
        """Update message(s) by id or index."""
        # batch mode
        if updates is not None:
            body: Dict[str, Any] = {"updates": updates}
            if metadata:
                body["metadata"] = metadata
            return await self._request("PATCH", f"/contexts/{context_id}", json=body)

        # single mode
        body = {**fields}
        if id is not None:
            body["id"] = id
        if index is not None:
            body["index"] = index

        if metadata:
            body = {"updates": [body], "metadata": metadata}

        return await self._request("PATCH", f"/contexts/{context_id}", json=body)

    async def delete(
        self,
        context_id: str,
        ids: Union[str, int, List[Union[str, int]]],
        *,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> DeleteResponse:
        """Delete messages by id(s) or index(es)."""
        items = ids if isinstance(ids, list) else [ids]
        body: Dict[str, Any] = {"ids": items}
        if metadata:
            body["metadata"] = metadata

        return await self._request("DELETE", f"/contexts/{context_id}", json=body)

    async def compress(
        self,
        context_id: str,
        *,
        preserve: Optional[List[str]] = None,
        mode: Optional[str] = None,
        recency_window: Optional[int] = None,
    ) -> CompressResponse:
        """Compress a context's messages."""
        body: Dict[str, Any] = {}
        if preserve is not None:
            body["preserve"] = preserve
        if mode is not None:
            body["mode"] = mode
        if recency_window is not None:
            body["recencyWindow"] = recency_window
        return await self._request("POST", f"/contexts/{context_id}/compress", json=body or None)

    async def uncompress(
        self,
        context_id: str,
        *,
        version: Optional[int] = None,
    ) -> UncompressResponse:
        """Uncompress a context back to its original messages."""
        body: Dict[str, Any] = {}
        if version is not None:
            body["version"] = version
        return await self._request("POST", f"/contexts/{context_id}/uncompress", json=body or None)
