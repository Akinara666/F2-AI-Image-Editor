import base64
import io
import threading
import time
from dataclasses import dataclass
from typing import Optional

from PIL import Image


@dataclass
class GenerationPreviewRecord:
    request_id: str
    total_steps: int
    step: int = 0
    status: str = "pending"
    image_data_url: Optional[str] = None
    updated_at: float = 0.0


class GenerationPreviewStore:
    def __init__(self, max_preview_side: int = 384, jpeg_quality: int = 60, ttl_seconds: int = 300):
        self.max_preview_side = max_preview_side
        self.jpeg_quality = jpeg_quality
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._records: dict[str, GenerationPreviewRecord] = {}

    def _prune_locked(self) -> None:
        cutoff = time.time() - self.ttl_seconds
        expired_ids = [
            request_id
            for request_id, record in self._records.items()
            if record.updated_at and record.updated_at < cutoff
        ]
        for request_id in expired_ids:
            self._records.pop(request_id, None)

    def _encode_image(self, image: Image.Image) -> str:
        preview_image = image.convert("RGB").copy()
        preview_image.thumbnail((self.max_preview_side, self.max_preview_side), Image.LANCZOS)

        buffer = io.BytesIO()
        preview_image.save(buffer, format="JPEG", quality=self.jpeg_quality, optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"

    def start(self, request_id: str, total_steps: int) -> None:
        with self._lock:
            self._prune_locked()
            self._records[request_id] = GenerationPreviewRecord(
                request_id=request_id,
                total_steps=max(1, int(total_steps)),
                updated_at=time.time(),
            )

    def update(self, request_id: str, *, step: int, total_steps: int, image: Image.Image, status: str = "running") -> None:
        image_data_url = self._encode_image(image)
        now = time.time()
        with self._lock:
            record = self._records.get(request_id)
            if record is None:
                record = GenerationPreviewRecord(
                    request_id=request_id,
                    total_steps=max(1, int(total_steps)),
                    updated_at=now,
                )
                self._records[request_id] = record

            record.step = max(0, int(step))
            record.total_steps = max(1, int(total_steps))
            record.status = status
            record.image_data_url = image_data_url
            record.updated_at = now
            self._prune_locked()

    def mark(self, request_id: str, *, status: str) -> None:
        now = time.time()
        with self._lock:
            record = self._records.get(request_id)
            if record is None:
                return
            record.status = status
            record.updated_at = now
            self._prune_locked()

    def get(self, request_id: str) -> Optional[dict[str, object]]:
        with self._lock:
            self._prune_locked()
            record = self._records.get(request_id)
            if record is None:
                return None
            return {
                "request_id": record.request_id,
                "status": record.status,
                "step": record.step,
                "total_steps": record.total_steps,
                "progress": min(1.0, record.step / record.total_steps) if record.total_steps else 0.0,
                "image_data_url": record.image_data_url,
                "updated_at": record.updated_at,
            }

    def clear(self, request_id: str) -> None:
        with self._lock:
            self._records.pop(request_id, None)


generation_preview_store = GenerationPreviewStore()
