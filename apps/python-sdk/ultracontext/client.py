"""UltraContext API client."""

from typing import Any, Dict, List, Optional, Union, overload
from urllib.parse import quote

import httpx

from ._local import _LocalBackend
from .exceptions import UltraContextHttpError
from .types import (
    AppendResponse,
    CreateContextResponse,
    DeleteManyResponse,
    DeleteResponse,
    GetContextResponse,
    ListContextsResponse,
    PermanentDeleteResponse,
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
        mode: Optional[str] = None,
        db: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
        headers: Optional[Dict[str, str]] = None,
    ):
        self._api_key = api_key
        self._base_url = (base_url or self.DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout or self.DEFAULT_TIMEOUT
        self._headers = headers or {}

        # local-by-default, remote opt-in (identical rule to the JS SDK):
        #   mode ?? (api_key ? 'remote' : 'local') — explicit mode always wins
        self._mode = mode or ("remote" if api_key else "local")

        # the local db target (app-specific, default ./ultracontext.db); the
        # backend is built lazily so a remote client never spawns a subprocess
        self._db = db
        self._local: Optional[_LocalBackend] = None

    def _backend(self) -> _LocalBackend:
        """Lazily build + memoize the local subprocess backend."""
        if self._local is None:
            self._local = _LocalBackend(db=self._db)
        return self._local

    def _build_headers(self, *, with_content_type: bool = True) -> Dict[str, str]:
        headers = {**self._headers}
        if with_content_type:
            headers["Content-Type"] = "application/json"
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
        accept_statuses: Optional[List[int]] = None,
    ) -> Any:
        """Make HTTP request."""

        # filter None values
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        url = f"{self._base_url}{path}"

        headers = self._build_headers(with_content_type=json is not None)

        with httpx.Client(timeout=self._timeout) as client:
            response = client.request(
                method,
                url,
                params=params,
                json=json,
                headers=headers,
            )

        # handle errors — accept_statuses lets callers surface non-2xx bodies (e.g. batch partial-fail)
        accepted = accept_statuses is not None and response.status_code in accept_statuses
        if not response.is_success and not accepted:
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
        # local backend → uc create subprocess
        if self._mode == "local":
            return self._backend().create(
                from_=from_, version=version, at=at, before=before, metadata=metadata
            )

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
        # local backend → uc get/list subprocess
        if self._mode == "local":
            if context_id is None:
                return self._backend().list(limit=limit)
            return self._backend().get(
                context_id, version=version, at=at, before=before, history=history
            )

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

        return self._request("GET", f"/contexts/{quote(context_id, safe='')}", params=params or None)

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
        # local backend → uc append subprocess
        if self._mode == "local":
            return self._backend().append(context_id, data)

        items = data if isinstance(data, list) else [data]
        return self._request("POST", f"/contexts/{quote(context_id, safe='')}", json=items)

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
        # local backend → uc update subprocess (single-target only; raises
        # NotImplementedError on batch/non-content updates)
        if self._mode == "local":
            return self._backend().update(
                context_id, updates, id=id, index=index, metadata=metadata, **fields
            )

        # batch mode
        if updates is not None:
            body: Dict[str, Any] = {"updates": updates}
            if metadata:
                body["metadata"] = metadata
            return self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

        # single mode
        body = {**fields}
        if id is not None:
            body["id"] = id
        if index is not None:
            body["index"] = index

        # wrap with version metadata if provided
        if metadata:
            body = {"updates": [body], "metadata": metadata}

        return self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

    def delete(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]] = None,
        *,
        permanent: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Union[DeleteResponse, PermanentDeleteResponse]:
        """
        Delete messages (soft, versioned) or the entire context (hard, permanent).

        Args:
            context_id: Context ID
            ids: Message ID, index, or list — soft delete (preserved in prior versions)
            permanent: If True, permanently delete the entire context (irreversible).
                Requires `ids` to be None.
            metadata: Audit metadata — version metadata for soft delete, echoed in
                response for permanent delete
        """
        # validate the soft/hard contract up-front — identical for BOTH modes, so
        # an empty ids list can never drift toward a whole-context wipe locally
        if permanent and ids is not None:
            raise ValueError("Cannot pass both `ids` and `permanent=True`")
        if not permanent and ids is None:
            raise ValueError("Either `ids` (soft delete) or `permanent=True` (hard delete) is required")
        if isinstance(ids, list) and not ids:
            raise ValueError("`ids` must be non-empty — pass `permanent=True` to delete the whole context")

        # local backend → uc delete subprocess (soft returns the CLI's
        # {deleted, id, data, version} superset — satisfies remote {data, version})
        if self._mode == "local":
            return self._backend().delete(context_id, ids, permanent=permanent, metadata=metadata)

        if permanent:
            body: Optional[Dict[str, Any]] = {"permanent": True}
            if metadata:
                body["metadata"] = metadata
            return self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

        items = ids if isinstance(ids, list) else [ids]
        body = {"ids": items}
        if metadata:
            body["metadata"] = metadata

        return self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

    def delete_many(self, ids: List[str]) -> DeleteManyResponse:
        """
        Delete multiple contexts permanently (max 100).

        Status 200 = all succeeded, 207 = partial, 500 = all failed. All three carry a
        results body; this method surfaces the body instead of raising.

        Args:
            ids: List of context IDs to delete
        """
        # local backend → fan-out permanent deletes (no local delete-many verb)
        if self._mode == "local":
            return self._backend().delete_many(ids)

        return self._request("POST", "/contexts/delete-many", json={"ids": ids}, accept_statuses=[200, 207, 500])


class AsyncUltraContext(_BaseClient):
    """Async UltraContext API client."""

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Any] = None,
        accept_statuses: Optional[List[int]] = None,
    ) -> Any:
        """Make async HTTP request."""

        # filter None values
        if params:
            params = {k: v for k, v in params.items() if v is not None}

        url = f"{self._base_url}{path}"

        headers = self._build_headers(with_content_type=json is not None)

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.request(
                method,
                url,
                params=params,
                json=json,
                headers=headers,
            )

        # handle errors — accept_statuses lets callers surface non-2xx bodies
        accepted = accept_statuses is not None and response.status_code in accept_statuses
        if not response.is_success and not accepted:
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
        # local backend → uc create subprocess
        if self._mode == "local":
            return await self._backend().acreate(
                from_=from_, version=version, at=at, before=before, metadata=metadata
            )

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

        # local backend → uc get/list subprocess
        if self._mode == "local":
            if context_id is None:
                return await self._backend().alist(limit=limit)
            return await self._backend().aget(
                context_id, version=version, at=at, before=before, history=history
            )

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

        return await self._request("GET", f"/contexts/{quote(context_id, safe='')}", params=params or None)

    async def append(
        self,
        context_id: str,
        data: Union[Dict[str, Any], List[Dict[str, Any]]],
    ) -> AppendResponse:
        """Append messages to context."""
        # local backend → uc append subprocess
        if self._mode == "local":
            return await self._backend().aappend(context_id, data)

        items = data if isinstance(data, list) else [data]
        return await self._request("POST", f"/contexts/{quote(context_id, safe='')}", json=items)

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
        # local backend → uc update subprocess (single-target only)
        if self._mode == "local":
            return await self._backend().aupdate(
                context_id, updates, id=id, index=index, metadata=metadata, **fields
            )

        # batch mode
        if updates is not None:
            body: Dict[str, Any] = {"updates": updates}
            if metadata:
                body["metadata"] = metadata
            return await self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

        # single mode
        body = {**fields}
        if id is not None:
            body["id"] = id
        if index is not None:
            body["index"] = index

        if metadata:
            body = {"updates": [body], "metadata": metadata}

        return await self._request("PATCH", f"/contexts/{quote(context_id, safe='')}", json=body)

    async def delete(
        self,
        context_id: str,
        ids: Optional[Union[str, int, List[Union[str, int]]]] = None,
        *,
        permanent: bool = False,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Union[DeleteResponse, PermanentDeleteResponse]:
        """Delete messages (soft, versioned) or the entire context (hard, permanent=True)."""
        # validate the soft/hard contract up-front — identical for BOTH modes, so
        # an empty ids list can never drift toward a whole-context wipe locally
        if permanent and ids is not None:
            raise ValueError("Cannot pass both `ids` and `permanent=True`")
        if not permanent and ids is None:
            raise ValueError("Either `ids` (soft delete) or `permanent=True` (hard delete) is required")
        if isinstance(ids, list) and not ids:
            raise ValueError("`ids` must be non-empty — pass `permanent=True` to delete the whole context")

        # local backend → uc delete subprocess (soft returns the {deleted, id,
        # data, version} superset — satisfies remote {data, version})
        if self._mode == "local":
            return await self._backend().adelete(context_id, ids, permanent=permanent, metadata=metadata)

        if permanent:
            body: Optional[Dict[str, Any]] = {"permanent": True}
            if metadata:
                body["metadata"] = metadata
            return await self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

        items = ids if isinstance(ids, list) else [ids]
        body = {"ids": items}
        if metadata:
            body["metadata"] = metadata

        return await self._request("DELETE", f"/contexts/{quote(context_id, safe='')}", json=body)

    async def delete_many(self, ids: List[str]) -> DeleteManyResponse:
        """Delete multiple contexts permanently (max 100). 200/207/500 all carry a results body."""
        # local backend → fan-out permanent deletes (no local delete-many verb)
        if self._mode == "local":
            return await self._backend().adelete_many(ids)

        return await self._request("POST", "/contexts/delete-many", json={"ids": ids}, accept_statuses=[200, 207, 500])
