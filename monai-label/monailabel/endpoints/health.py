"""Readiness of the base API, independent of optional AI resources."""
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from monailabel.utils.others.model_runtime import model_status

router = APIRouter(tags=["App"])


@router.get("/health")
def health():
    return {"status": "ok", "models": model_status()}


async def model_runtime_error_handler(request, exc):
    return JSONResponse(status_code=503, content=exc.payload())
