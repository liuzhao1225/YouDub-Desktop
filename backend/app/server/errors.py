"""Unified application errors and FastAPI error serialization."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from ..v1.errors import ApiError


class AppError(Exception):
    """Structured HTTP error emitted using the standard YouDub error envelope."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details

    def to_payload(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details is not None:
            error["details"] = self.details
        return {"error": error}


class TaskCancelledError(Exception):
    """Raised internally when an active task is cancelled."""

    def __init__(self, message: str = "Task cancelled.") -> None:
        super().__init__(message)
        self.message = message


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _handle_app_error(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    @app.exception_handler(ApiError)
    async def _handle_api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.content)

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Invalid request payload.",
                    "details": exc.errors(),
                }
            },
        )
