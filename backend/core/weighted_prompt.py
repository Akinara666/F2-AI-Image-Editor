import logging
import re
from typing import Optional

import torch


logger = logging.getLogger("WeightedPrompt")

_RE_ATTENTION = re.compile(
    r"""
\\\(|\\\)|\\\[|\\]|\\\\|\\|
\(|\[|:([+-]?\d*\.?\d+)\)|\)|]|
[^\\()\[\]:]+|:
""",
    re.X,
)


def has_weighted_prompt_syntax(text: Optional[str]) -> bool:
    if not text:
        return False
    return bool(re.search(r"(?<!\\)[\(\)\[\]]|:\s*[+-]?\d*\.?\d+\s*\)", text))


def parse_prompt_attention(text: str) -> list[tuple[str, float]]:
    """
    A1111-like prompt parser:
    - (text) => 1.1
    - [text] => 1/1.1
    - (text:1.2) => 1.2
    """
    res: list[list[object]] = []
    round_brackets: list[int] = []
    square_brackets: list[int] = []

    round_bracket_multiplier = 1.1
    square_bracket_multiplier = 1 / 1.1

    def multiply_range(start_position: int, multiplier: float) -> None:
        for pos in range(start_position, len(res)):
            res[pos][1] *= multiplier

    for match in _RE_ATTENTION.finditer(text):
        token = match.group(0)
        weight = match.group(1)

        if token.startswith("\\"):
            res.append([token[1:], 1.0])
        elif token == "(":
            round_brackets.append(len(res))
        elif token == "[":
            square_brackets.append(len(res))
        elif weight is not None and round_brackets:
            multiply_range(round_brackets.pop(), float(weight))
        elif token == ")" and round_brackets:
            multiply_range(round_brackets.pop(), round_bracket_multiplier)
        elif token == "]" and square_brackets:
            multiply_range(square_brackets.pop(), square_bracket_multiplier)
        else:
            res.append([token, 1.0])

    for pos in round_brackets:
        multiply_range(pos, round_bracket_multiplier)
    for pos in square_brackets:
        multiply_range(pos, square_bracket_multiplier)

    if not res:
        return [("", 1.0)]

    merged: list[tuple[str, float]] = []
    for text_chunk, weight in res:
        if merged and merged[-1][1] == weight:
            merged[-1] = (merged[-1][0] + str(text_chunk), weight)
        else:
            merged.append((str(text_chunk), float(weight)))
    return merged


def _tokenize_with_weights(tokenizer, text: str) -> tuple[list[int], list[float]]:
    token_ids: list[int] = []
    token_weights: list[float] = []

    for text_chunk, weight in parse_prompt_attention(text):
        if not text_chunk:
            continue
        chunk_token_ids = tokenizer(text_chunk, add_special_tokens=False).input_ids
        if not chunk_token_ids:
            continue
        token_ids.extend(chunk_token_ids)
        token_weights.extend([weight] * len(chunk_token_ids))

    return token_ids, token_weights


def _build_token_tensors(tokenizer, text: str) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    token_ids, token_weights = _tokenize_with_weights(tokenizer, text)

    max_length = int(tokenizer.model_max_length)
    body_max_length = max(1, max_length - 2)
    bos_token_id = tokenizer.bos_token_id
    eos_token_id = tokenizer.eos_token_id or tokenizer.sep_token_id
    pad_token_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos_token_id

    if bos_token_id is None or eos_token_id is None:
        raise RuntimeError(f"Tokenizer {type(tokenizer).__name__} is missing BOS/EOS tokens.")

    if len(token_ids) > body_max_length:
        logger.warning(
            "Weighted prompt was truncated from %s to %s tokens for tokenizer %s",
            len(token_ids),
            body_max_length,
            type(tokenizer).__name__,
        )
        token_ids = token_ids[:body_max_length]
        token_weights = token_weights[:body_max_length]

    sequence_ids = [bos_token_id, *token_ids, eos_token_id]
    sequence_weights = [1.0, *token_weights, 1.0]
    attention_mask = [1] * len(sequence_ids)

    pad_length = max_length - len(sequence_ids)
    if pad_length > 0:
        sequence_ids.extend([pad_token_id] * pad_length)
        sequence_weights.extend([1.0] * pad_length)
        attention_mask.extend([0] * pad_length)

    return (
        torch.tensor([sequence_ids], dtype=torch.long),
        torch.tensor([sequence_weights], dtype=torch.float32),
        torch.tensor([attention_mask], dtype=torch.long),
    )


def _apply_weights_to_embeddings(embeddings: torch.Tensor, token_weights: torch.Tensor) -> torch.Tensor:
    token_weights = token_weights.to(device=embeddings.device, dtype=embeddings.dtype)
    weighted_embeddings = embeddings * token_weights.unsqueeze(-1)

    original_mean = embeddings.float().mean(dim=(-2, -1), keepdim=True)
    weighted_mean = weighted_embeddings.float().mean(dim=(-2, -1), keepdim=True)
    weighted_mean = torch.where(weighted_mean == 0, torch.ones_like(weighted_mean), weighted_mean)

    return weighted_embeddings * (original_mean / weighted_mean).to(dtype=embeddings.dtype)


def _encode_sd_prompt_embeddings(
    pipe,
    text: str,
    device: torch.device,
    clip_skip: Optional[int],
    *,
    apply_clip_skip: bool,
) -> torch.Tensor:
    input_ids, token_weights, attention_mask = _build_token_tensors(pipe.tokenizer, text)
    use_attention_mask = bool(
        hasattr(pipe.text_encoder.config, "use_attention_mask") and pipe.text_encoder.config.use_attention_mask
    )
    encoder_kwargs = {
        "input_ids": input_ids.to(device),
        "attention_mask": attention_mask.to(device) if use_attention_mask else None,
        "output_hidden_states": apply_clip_skip and clip_skip is not None,
    }
    encoder_output = pipe.text_encoder(**encoder_kwargs)
    if not apply_clip_skip or clip_skip is None:
        prompt_embeds = encoder_output[0]
    else:
        prompt_embeds = encoder_output[-1][-(clip_skip + 1)]
        prompt_embeds = pipe.text_encoder.text_model.final_layer_norm(prompt_embeds)

    prompt_embeds = _apply_weights_to_embeddings(prompt_embeds, token_weights)
    return prompt_embeds.to(dtype=pipe.text_encoder.dtype, device=device)


def _encode_sdxl_prompt_embeddings(
    text_encoder,
    tokenizer,
    text: str,
    device: torch.device,
    clip_skip: Optional[int],
    *,
    apply_clip_skip: bool,
):
    input_ids, token_weights, _attention_mask = _build_token_tensors(tokenizer, text)
    encoder_output = text_encoder(input_ids.to(device), output_hidden_states=True)
    pooled_prompt_embeds = encoder_output[0] if encoder_output[0].ndim == 2 else None

    if not apply_clip_skip or clip_skip is None:
        prompt_embeds = encoder_output.hidden_states[-2]
    else:
        prompt_embeds = encoder_output.hidden_states[-(clip_skip + 2)]

    prompt_embeds = _apply_weights_to_embeddings(prompt_embeds, token_weights)
    return prompt_embeds, pooled_prompt_embeds


def build_weighted_prompt_kwargs(
    pipe,
    *,
    prompt: str,
    negative_prompt: str,
    device: torch.device,
    clip_skip: Optional[int],
) -> dict[str, torch.Tensor]:
    if hasattr(pipe, "text_encoder_2") and hasattr(pipe, "tokenizer_2") and pipe.text_encoder_2 is not None:
        positive_prompt_embeds_parts = []
        negative_prompt_embeds_parts = []
        pooled_prompt_embeds = None
        negative_pooled_prompt_embeds = None

        prompt_variants = [prompt, prompt]
        negative_variants = [negative_prompt, negative_prompt]
        tokenizers = [pipe.tokenizer, pipe.tokenizer_2]
        text_encoders = [pipe.text_encoder, pipe.text_encoder_2]

        for idx, (current_prompt, current_negative_prompt, tokenizer, text_encoder) in enumerate(
            zip(prompt_variants, negative_variants, tokenizers, text_encoders)
        ):
            prompt_embeds_part, pooled_part = _encode_sdxl_prompt_embeddings(
                text_encoder,
                tokenizer,
                current_prompt,
                device,
                clip_skip,
                apply_clip_skip=True,
            )
            negative_embeds_part, negative_pooled_part = _encode_sdxl_prompt_embeddings(
                text_encoder,
                tokenizer,
                current_negative_prompt,
                device,
                clip_skip,
                apply_clip_skip=False,
            )
            positive_prompt_embeds_parts.append(prompt_embeds_part)
            negative_prompt_embeds_parts.append(negative_embeds_part)
            if pooled_part is not None and pooled_prompt_embeds is None:
                pooled_prompt_embeds = pooled_part
            if negative_pooled_part is not None and negative_pooled_prompt_embeds is None:
                negative_pooled_prompt_embeds = negative_pooled_part

        prompt_embeds = torch.concat(positive_prompt_embeds_parts, dim=-1)
        negative_prompt_embeds = torch.concat(negative_prompt_embeds_parts, dim=-1)

        target_dtype = pipe.text_encoder_2.dtype if pipe.text_encoder_2 is not None else pipe.unet.dtype
        prompt_embeds = prompt_embeds.to(dtype=target_dtype, device=device)
        negative_prompt_embeds = negative_prompt_embeds.to(dtype=target_dtype, device=device)
        if pooled_prompt_embeds is not None:
            pooled_prompt_embeds = pooled_prompt_embeds.to(dtype=target_dtype, device=device)
        if negative_pooled_prompt_embeds is not None:
            negative_pooled_prompt_embeds = negative_pooled_prompt_embeds.to(dtype=target_dtype, device=device)

        return {
            "prompt": None,
            "negative_prompt": None,
            "prompt_embeds": prompt_embeds,
            "negative_prompt_embeds": negative_prompt_embeds,
            "pooled_prompt_embeds": pooled_prompt_embeds,
            "negative_pooled_prompt_embeds": negative_pooled_prompt_embeds,
        }

    prompt_embeds = _encode_sd_prompt_embeddings(
        pipe,
        prompt,
        device,
        clip_skip,
        apply_clip_skip=True,
    )
    negative_prompt_embeds = _encode_sd_prompt_embeddings(
        pipe,
        negative_prompt,
        device,
        clip_skip,
        apply_clip_skip=False,
    )
    return {
        "prompt": None,
        "negative_prompt": None,
        "prompt_embeds": prompt_embeds,
        "negative_prompt_embeds": negative_prompt_embeds,
    }
