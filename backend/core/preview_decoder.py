import threading
from pathlib import Path
from typing import Optional

import torch
from PIL import Image
from diffusers import AutoencoderTiny
from torch import nn

from core.config import settings


LIVE_PREVIEW_METHOD_CHOICES = ("full", "approx_nn", "approx_cheap", "taesd")

TAESD_MODEL_IDS = {
    "sd": "madebyollin/taesd",
    "sdxl": "madebyollin/taesdxl",
}

CHEAP_APPROXIMATION_COEFFS = {
    "sd": [
        [0.2980, 0.2070, 0.2080],
        [0.1870, 0.2860, 0.1730],
        [-0.1580, 0.1890, 0.2640],
        [-0.1840, -0.2710, -0.4730],
    ],
    "sdxl": [
        [0.3448, 0.4168, 0.4395],
        [-0.1953, -0.0290, 0.0250],
        [0.1074, 0.0886, -0.0163],
        [-0.3730, -0.2499, -0.2088],
    ],
}


class VAEApprox(nn.Module):
    def __init__(self, latent_channels: int = 4):
        super().__init__()
        self.conv1 = nn.Conv2d(latent_channels, 8, (7, 7))
        self.conv2 = nn.Conv2d(8, 16, (5, 5))
        self.conv3 = nn.Conv2d(16, 32, (3, 3))
        self.conv4 = nn.Conv2d(32, 64, (3, 3))
        self.conv5 = nn.Conv2d(64, 32, (3, 3))
        self.conv6 = nn.Conv2d(32, 16, (3, 3))
        self.conv7 = nn.Conv2d(16, 8, (3, 3))
        self.conv8 = nn.Conv2d(8, 3, (3, 3))

    def forward(self, x):
        extra = 11
        x = nn.functional.interpolate(x, (x.shape[2] * 2, x.shape[3] * 2))
        x = nn.functional.pad(x, (extra, extra, extra, extra))
        for layer in (
            self.conv1,
            self.conv2,
            self.conv3,
            self.conv4,
            self.conv5,
            self.conv6,
            self.conv7,
            self.conv8,
        ):
            x = layer(x)
            x = nn.functional.leaky_relu(x, 0.1)
        return x


class PreviewDecoder:
    def __init__(self):
        import logging
        self.logger = logging.getLogger("PreviewDecoder")
        self._lock = threading.Lock()
        self._approx_models: dict[str, nn.Module] = {}
        self._taesd_models: dict[str, AutoencoderTiny] = {}

    @staticmethod
    def normalize_method(method: Optional[str]) -> str:
        normalized = str(method or settings.LIVE_PREVIEW_METHOD).strip().lower()
        if normalized not in LIVE_PREVIEW_METHOD_CHOICES:
            fallback = str(settings.LIVE_PREVIEW_METHOD or "full").strip().lower()
            if fallback in LIVE_PREVIEW_METHOD_CHOICES:
                return fallback
            return "full"
        return normalized

    def prepare(self, pipe, model_family: str, method: Optional[str]) -> str:
        resolved_method = self.normalize_method(method)
        try:
            if resolved_method == "approx_nn":
                self._get_approx_model(model_family, latent_channels=self._infer_latent_channels(pipe))
            elif resolved_method == "taesd":
                self._get_taesd_model(model_family, torch_dtype=self._infer_pipe_dtype(pipe))
        except Exception as exc:
            self.logger.warning(
                "Failed to prepare preview method %s for family=%s: %s. Falling back to approx_cheap.",
                resolved_method,
                model_family,
                exc,
            )
            return "approx_cheap"
        return resolved_method

    def decode(self, pipe, latents: torch.Tensor, model_family: str, method: Optional[str]) -> Optional[Image.Image]:
        resolved_method = self.normalize_method(method)
        try:
            if resolved_method == "approx_cheap":
                return self._decode_cheap(latents, model_family)
            if resolved_method == "approx_nn":
                return self._decode_approx_nn(pipe, latents, model_family)
            if resolved_method == "taesd":
                return self._decode_taesd(latents, model_family)
            return self._decode_full(pipe, latents)
        except Exception as exc:
            self.logger.warning(
                "Preview decode method %s failed for family=%s: %s. Falling back to approx_cheap.",
                resolved_method,
                model_family,
                exc,
            )
            return self._decode_cheap(latents, model_family)

    def _infer_latent_channels(self, pipe) -> int:
        latent_channels = getattr(getattr(pipe, "unet", None), "config", None)
        if latent_channels is not None:
            return int(getattr(pipe.unet.config, "in_channels", 4))
        return 4

    def _resolve_approx_model_path(self, model_family: str) -> tuple[Path, str]:
        model_name = "vaeapprox-sdxl.pt" if model_family == "sdxl" else "model.pt"
        model_dir = settings.BASE_DIR / "models" / "VAE-approx"
        model_path = model_dir / model_name
        download_url = f"https://github.com/AUTOMATIC1111/stable-diffusion-webui/releases/download/v1.0.0-pre/{model_name}"
        return model_path, download_url

    def _get_approx_model(self, model_family: str, latent_channels: int) -> nn.Module:
        cache_key = f"{model_family}:{latent_channels}"
        with self._lock:
            cached_model = self._approx_models.get(cache_key)
            if cached_model is not None:
                return cached_model

            model_path, download_url = self._resolve_approx_model_path(model_family)
            if not model_path.exists():
                model_path.parent.mkdir(parents=True, exist_ok=True)
                self.logger.info("Downloading Approx NN preview model: %s", model_path)
                torch.hub.download_url_to_file(download_url, str(model_path))

            model = VAEApprox(latent_channels=latent_channels)
            state_dict = torch.load(str(model_path), map_location="cpu")
            model.load_state_dict(state_dict)
            model.eval()
            self._approx_models[cache_key] = model
            self.logger.info("Loaded Approx NN preview model: family=%s channels=%s path=%s", model_family, latent_channels, model_path)
            return model

    @staticmethod
    def _infer_pipe_dtype(pipe) -> Optional[torch.dtype]:
        dtype = getattr(pipe, "dtype", None)
        if isinstance(dtype, torch.dtype):
            return dtype
        unet = getattr(pipe, "unet", None)
        unet_dtype = getattr(unet, "dtype", None)
        return unet_dtype if isinstance(unet_dtype, torch.dtype) else None

    def _get_taesd_model(self, model_family: str, torch_dtype: Optional[torch.dtype] = None) -> AutoencoderTiny:
        with self._lock:
            cached_model = self._taesd_models.get(model_family)
            if cached_model is not None:
                return cached_model

            repo_id = TAESD_MODEL_IDS[model_family]
            self.logger.info(
                "Loading TAESD preview model: family=%s repo=%s dtype=%s",
                model_family,
                repo_id,
                torch_dtype,
            )
            # Load directly in the runtime dtype to skip the fp32 materialization
            # + later conversion; _decode_* still re-casts as a safety net.
            load_kwargs = {"torch_dtype": torch_dtype} if torch_dtype is not None else {}
            model = AutoencoderTiny.from_pretrained(repo_id, **load_kwargs)
            model.eval()
            self._taesd_models[model_family] = model
            return model

    def _latents_to_rgb_image(self, rgb_tensor: torch.Tensor, *, upscale_factor: int = 8) -> Image.Image:
        image_tensor = rgb_tensor.detach().float().cpu()
        image_tensor = image_tensor[:1]
        image_tensor = image_tensor.permute(0, 2, 3, 1)[0]
        image_tensor = image_tensor - image_tensor.min()
        max_value = image_tensor.max()
        if max_value > 0:
            image_tensor = image_tensor / max_value
        image_uint8 = (image_tensor.clamp(0, 1).numpy() * 255).round().astype("uint8")
        image = Image.fromarray(image_uint8, mode="RGB")
        if upscale_factor > 1:
            image = image.resize(
                (image.width * upscale_factor, image.height * upscale_factor),
                Image.Resampling.BILINEAR,
            )
        return image

    def _decode_cheap(self, latents: torch.Tensor, model_family: str) -> Image.Image:
        coeffs = torch.tensor(
            CHEAP_APPROXIMATION_COEFFS["sdxl" if model_family == "sdxl" else "sd"],
            device=latents.device,
            dtype=latents.dtype,
        )
        rgb_tensor = torch.einsum("...lxy,lr -> ...rxy", latents[:1], coeffs)
        return self._latents_to_rgb_image(rgb_tensor, upscale_factor=8)

    def _decode_approx_nn(self, pipe, latents: torch.Tensor, model_family: str) -> Image.Image:
        model = self._get_approx_model(model_family, latent_channels=self._infer_latent_channels(pipe))
        reference_param = next(model.parameters(), None)
        target_device = latents.device if reference_param is None else reference_param.device
        target_dtype = latents.dtype if reference_param is None else reference_param.dtype
        if reference_param is None or reference_param.device != latents.device or reference_param.dtype != latents.dtype:
            model = model.to(device=latents.device, dtype=latents.dtype)
        with torch.inference_mode():
            rgb_tensor = model(latents[:1].to(device=target_device, dtype=target_dtype))
        return self._latents_to_rgb_image(rgb_tensor, upscale_factor=4)

    def _decode_taesd(self, latents: torch.Tensor, model_family: str) -> Image.Image:
        model = self._get_taesd_model(model_family, torch_dtype=latents.dtype)
        reference_param = next(model.parameters(), None)
        target_device = latents.device if reference_param is None else reference_param.device
        target_dtype = latents.dtype if reference_param is None else reference_param.dtype
        if reference_param is None or reference_param.device != latents.device or reference_param.dtype != latents.dtype:
            model = model.to(device=latents.device, dtype=latents.dtype)
        with torch.inference_mode():
            decoded = model.decode(latents[:1].to(device=target_device, dtype=target_dtype)).sample
        decoded = (decoded / 2 + 0.5).clamp(0, 1)
        image_array = (
            decoded[0]
            .detach()
            .cpu()
            .permute(1, 2, 0)
            .float()
            .numpy()
        )
        return Image.fromarray((image_array * 255).round().astype("uint8"))

    def _decode_full(self, pipe, latents: torch.Tensor) -> Optional[Image.Image]:
        if not hasattr(pipe, "vae") or pipe.vae is None:
            return None

        preview_latents = latents.detach()[:1]
        scaling_factor = getattr(pipe.vae.config, "scaling_factor", None) or 0.18215
        preview_latents = preview_latents / scaling_factor

        vae = pipe.vae
        original_vae_dtype = getattr(vae, "dtype", None)
        vae_reference_param = next(vae.parameters(), None)
        vae_device = vae_reference_param.device if vae_reference_param is not None else preview_latents.device
        needs_upcast = bool(getattr(getattr(vae, "config", None), "force_upcast", False))
        preview_dtype = original_vae_dtype

        if needs_upcast:
            vae.to(device=vae_device, dtype=torch.float32)
            preview_dtype = torch.float32

        try:
            if preview_dtype is not None:
                preview_latents = preview_latents.to(device=vae_device, dtype=preview_dtype)
            else:
                preview_latents = preview_latents.to(device=vae_device)

            with torch.inference_mode():
                image_tensor = vae.decode(preview_latents, return_dict=False)[0]
        finally:
            if needs_upcast and original_vae_dtype is not None:
                vae.to(device=vae_device, dtype=original_vae_dtype)

        if hasattr(pipe, "image_processor") and pipe.image_processor is not None:
            images = pipe.image_processor.postprocess(image_tensor, output_type="pil")
            return images[0] if images else None

        image_tensor = (image_tensor / 2 + 0.5).clamp(0, 1)
        image_array = (
            image_tensor[0]
            .detach()
            .cpu()
            .permute(1, 2, 0)
            .float()
            .numpy()
        )
        return Image.fromarray((image_array * 255).round().astype("uint8"))


preview_decoder = PreviewDecoder()
