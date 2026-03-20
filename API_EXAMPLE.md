
### API Contract Implementation

Below is an example of a JSON Request/Response for the `/generate` endpoint.
Note that the actual API uses `multipart/form-data` because we are uploading files (images, masks), but the logical structure is as follows.

#### Request (Multipart/Form-Data)

```json
{
  "prompt": "A futuristic city with neon lights, cyberpunk style",
  "raw_prompt": "Нарисуй футуристичный неоновый киберпанк-город",
  "use_prompt_transform": true,
  "negative_prompt": "low quality, blurry, ugly",
  "width": 512,
  "height": 512,
  "steps": 25,
  "cfg": 7.5,
  "seed": 12345678,
  "model_id": "stabilityai/stable-diffusion-2-1",
  "mode": "inpainting",
  "init_image": "(Unknown Binaries - the source crop)",
  "mask_image": "(Unknown Binaries - the B/W mask)"
}
```

#### Response (JSON)

```json
{
  "status": "success",
  "url": "/outputs/20260112_091500_futuristic_city.png",
  "meta": {
    "prompt": "A futuristic city with neon lights, cyberpunk style",
    "raw_prompt": "Нарисуй футуристичный неоновый киберпанк-город",
    "transformed_prompt": "futuristic neon cyberpunk city, highly detailed, cinematic lighting",
    "transformed_negative_prompt": "low quality, blurry, ugly, jpeg artifacts",
    "prompt_transform_status": "success",
    "prompt_transform_provider": "stub",
    "prompt_transform_latency_ms": 12,
    "negative_prompt": "low quality, blurry, ugly, jpeg artifacts",
    "raw_negative_prompt": "low quality, blurry, ugly",
    "seed": 12345678,
    "steps": 25,
    "cfg": 7.5,
    "model_id": "stabilityai/stable-diffusion-2-1"
  }
}
```

_The output PNG file at that URL will contain the exact same 'meta' object embedded in its tEXt chunk._

#### Error Response (when transform is required but failed)

```json
{
  "detail": "Prompt was not transformed. status=fallback_error"
}
```
