import contextlib
import importlib
import sys
import types


def _install_torch_stub() -> None:
    if "torch" in sys.modules:
        return

    torch = types.ModuleType("torch")
    torch.float16 = "float16"
    torch.float32 = "float32"
    torch.dtype = object
    torch.Tensor = object

    class _Generator:
        def __init__(self, device=None):
            self.device = device
            self.seed = None

        def manual_seed(self, seed):
            self.seed = seed
            return self

    class _Module:
        def __init__(self, *args, **kwargs):
            pass

        def eval(self):
            return self

        def to(self, *args, **kwargs):
            return self

        def parameters(self):
            return iter(())

    class _Conv2d(_Module):
        pass

    nn = types.ModuleType("torch.nn")
    nn.Module = _Module
    nn.Conv2d = _Conv2d
    nn.functional = types.SimpleNamespace(
        interpolate=lambda x, size=None: x,
        pad=lambda x, pads: x,
        leaky_relu=lambda x, slope=0.1: x,
    )

    torch.Generator = _Generator
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: False,
        empty_cache=lambda: None,
    )
    torch.hub = types.SimpleNamespace(download_url_to_file=lambda url, path: None)
    torch.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: False)
    )
    torch.inference_mode = contextlib.nullcontext
    torch.no_grad = contextlib.nullcontext
    torch.nn = nn

    sys.modules["torch"] = torch
    sys.modules["torch.nn"] = nn


def _install_diffusers_stub() -> None:
    if "diffusers" in sys.modules:
        return

    diffusers = types.ModuleType("diffusers")

    class _Placeholder:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs
            self.scheduler = types.SimpleNamespace(config={})

        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls(*args, **kwargs)

        @classmethod
        def from_config(cls, *args, **kwargs):
            return cls(*args, **kwargs)

    names = [
        "StableDiffusionPipeline",
        "StableDiffusionImg2ImgPipeline",
        "StableDiffusionInpaintPipeline",
        "StableDiffusionXLPipeline",
        "StableDiffusionXLImg2ImgPipeline",
        "StableDiffusionXLInpaintPipeline",
        "ControlNetModel",
        "StableDiffusionControlNetPipeline",
        "AutoencoderTiny",
        "EulerAncestralDiscreteScheduler",
        "EulerDiscreteScheduler",
        "DPMSolverMultistepScheduler",
        "DDIMScheduler",
        "LMSDiscreteScheduler",
        "DPMSolverSDEScheduler",
        "KDPM2AncestralDiscreteScheduler",
        "HeunDiscreteScheduler",
        "UniPCMultistepScheduler",
        "DDPMScheduler",
    ]
    for name in names:
        setattr(diffusers, name, _Placeholder)

    sys.modules["diffusers"] = diffusers


def _install_compel_stub() -> None:
    if "compel" in sys.modules:
        return

    compel = types.ModuleType("compel")

    class _CompelForSD:
        def __init__(self, pipe=None):
            self.pipe = pipe

        def __call__(self, prompt):
            return prompt

    class _CompelForSDXL:
        def __init__(self, pipe=None):
            self.pipe = pipe

        def __call__(self, prompt):
            return prompt, prompt

    compel.CompelForSD = _CompelForSD
    compel.CompelForSDXL = _CompelForSDXL
    sys.modules["compel"] = compel


def load_app_main():
    _install_torch_stub()
    _install_diffusers_stub()
    _install_compel_stub()
    return importlib.import_module("main")
